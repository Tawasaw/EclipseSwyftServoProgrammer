//! Serial transport for the servo programmer (USB-to-UART adapter, single-wire half-duplex).

use crate::protocol::{self, Frame};
use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

pub const DEFAULT_BAUD: u32 = 115_200;
pub const RESPONSE_TIMEOUT: Duration = Duration::from_millis(600);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub description: String,
    pub score: i32,
}

/// Lists serial ports, best adapter candidates first.
pub fn list_ports() -> Vec<PortInfo> {
    let mut ports: Vec<PortInfo> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !is_redundant_mac_tty(&p.port_name))
        .map(|p| {
            let (description, usb) = match &p.port_type {
                SerialPortType::UsbPort(u) => {
                    let mut parts: Vec<String> = Vec::new();
                    if let Some(m) = &u.manufacturer {
                        parts.push(m.clone());
                    }
                    if let Some(prod) = &u.product {
                        parts.push(prod.clone());
                    }
                    parts.push(format!("USB {:04X}:{:04X}", u.vid, u.pid));
                    (parts.join(" · "), Some((u.vid, u.pid)))
                }
                SerialPortType::BluetoothPort => ("Bluetooth".to_string(), None),
                SerialPortType::PciPort => ("PCI serial".to_string(), None),
                SerialPortType::Unknown => (String::new(), None),
            };
            let score = adapter_score(&p.port_name, &description, usb);
            PortInfo {
                name: p.port_name,
                description,
                score,
            }
        })
        .collect();
    ports.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| natural_key(&a.name).cmp(&natural_key(&b.name)))
    });
    ports
}

/// On macOS every device appears as both /dev/tty.* and /dev/cu.*. The cu.* "call-up" node is the
/// right one for an outgoing connection (tty.* blocks waiting for carrier detect), so hide tty.*.
fn is_redundant_mac_tty(name: &str) -> bool {
    cfg!(target_os = "macos") && name.starts_with("/dev/tty.")
}

/// Ranks a port by how likely it is to be the servo's USB-to-UART adapter.
fn adapter_score(name: &str, description: &str, usb: Option<(u16, u16)>) -> i32 {
    let d = format!("{name} {description}").to_lowercase();
    if d.contains("bluetooth") || d.contains("debug-console") {
        return -100;
    }
    match usb {
        Some((0x10C4, _)) => 100, // Silicon Labs CP210x (SWYFT programmer)
        Some((0x1A86, _)) | Some((0x0403, _)) | Some((0x067B, _)) => 70, // CH34x, FTDI, PL2303
        Some(_) if d.contains("uart") || d.contains("serial") => 80,
        Some(_) => 50,
        None if d.contains("usbserial") || d.contains("ttyusb") || d.contains("slab") => 60,
        None => 0,
    }
}

fn natural_key(name: &str) -> (String, u64) {
    let digits: String = name.chars().filter(|c| c.is_ascii_digit()).collect();
    let prefix: String = name.chars().filter(|c| !c.is_ascii_digit()).collect();
    (prefix, digits.parse().unwrap_or(0))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "message")]
pub enum TransportError {
    NotConnected(String),
    Open(String),
    Io(String),
    Timeout(String),
}

impl TransportError {
    /// True when the port should be considered gone (e.g. adapter unplugged).
    pub fn is_fatal(&self) -> bool {
        matches!(self, TransportError::Io(_))
    }
}

pub struct Connection {
    pub name: String,
    pub baud: u32,
    port: Box<dyn SerialPort>,
}

impl Connection {
    /// Opens the port at `baud`, 8-N-2, no flow control (matches the original programmer).
    pub fn open(name: &str, baud: u32) -> Result<Self, TransportError> {
        let port = serialport::new(name, baud)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::Two)
            .flow_control(FlowControl::None)
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(|e| TransportError::Open(open_error_hint(name, &e)))?;
        let _ = port.clear(serialport::ClearBuffer::All);
        Ok(Self {
            name: name.to_string(),
            baud,
            port,
        })
    }

    /// Sends `frame` and waits for a reply frame that satisfies `accept`.
    /// Returns the reply plus every byte received (for diagnostics).
    pub fn transact(
        &mut self,
        frame: &Frame,
        accept: fn(&[u8]) -> bool,
    ) -> Result<(Frame, Vec<u8>), TransportError> {
        let io = |e: io::Error| TransportError::Io(e.to_string());
        self.port
            .clear(serialport::ClearBuffer::All)
            .map_err(|e| TransportError::Io(e.to_string()))?;
        self.port.write_all(frame).map_err(io)?;
        self.port.flush().map_err(io)?;

        let deadline = Instant::now() + RESPONSE_TIMEOUT;
        let mut received = Vec::with_capacity(64);
        let mut chunk = [0u8; 64];
        loop {
            match self.port.read(&mut chunk) {
                Ok(0) => {}
                Ok(n) => {
                    received.extend_from_slice(&chunk[..n]);
                    if let Some(reply) = protocol::find_frame(&received, accept) {
                        return Ok((reply, received));
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::TimedOut => {}
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(io(e)),
            }
            if Instant::now() >= deadline {
                let detail = if received.is_empty() {
                    "no bytes received".to_string()
                } else {
                    format!(
                        "received {} byte(s): {}",
                        received.len(),
                        protocol::hex(&received)
                    )
                };
                return Err(TransportError::Timeout(detail));
            }
        }
    }
}

fn open_error_hint(name: &str, e: &serialport::Error) -> String {
    let mut msg = format!("Failed to open {name}: {e}");
    let lower = e.to_string().to_lowercase();
    if cfg!(target_os = "linux") && (lower.contains("permission") || lower.contains("denied")) {
        msg.push_str(
            ". Add your user to the serial group (e.g. `sudo usermod -aG dialout $USER`, \
             or `uucp` on Arch) and log out/in.",
        );
    } else if lower.contains("busy") || lower.contains("access is denied") {
        msg.push_str(". Another program may be using this port.");
    }
    msg
}
