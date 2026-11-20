pub mod protocol;
pub mod serial;

use protocol::ServoParameters;
use serde::Serialize;
use serial::{Connection, PortInfo, TransportError};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

/// Read attempts before reporting a timeout (each waits up to serial::RESPONSE_TIMEOUT).
const READ_ATTEMPTS: u32 = 4;

#[derive(Default)]
struct AppState {
    conn: Arc<Mutex<Option<Connection>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatus {
    connected: bool,
    port: Option<String>,
    baud: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadResult {
    params: ServoParameters,
    reply: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteResult {
    sent: String,
    reply: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    os: &'static str,
}

fn status_of(conn: &Option<Connection>) -> ConnectionStatus {
    ConnectionStatus {
        connected: conn.is_some(),
        port: conn.as_ref().map(|c| c.name.clone()),
        baud: conn.as_ref().map(|c| c.baud),
    }
}

/// Runs a blocking serial transaction off the main thread. Drops the connection on fatal I/O errors
/// (e.g. the adapter was unplugged) so the UI falls back to "disconnected".
async fn with_connection<T: Send + 'static>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&mut Connection) -> Result<T, TransportError> + Send + 'static,
) -> Result<T, TransportError> {
    let shared = Arc::clone(&state.conn);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = shared.lock().expect("connection lock");
        let conn = guard
            .as_mut()
            .ok_or_else(|| TransportError::NotConnected("The serial port is not open.".into()))?;
        let result = f(conn);
        if matches!(&result, Err(e) if e.is_fatal()) {
            *guard = None;
        }
        result
    })
    .await
    .map_err(|e| TransportError::Io(e.to_string()))?
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
    }
}

#[tauri::command]
async fn list_ports() -> Vec<PortInfo> {
    tauri::async_runtime::spawn_blocking(serial::list_ports)
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn connection_status(state: State<'_, AppState>) -> ConnectionStatus {
    status_of(&state.conn.lock().expect("connection lock"))
}

#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    port: String,
    baud: Option<u32>,
) -> Result<ConnectionStatus, TransportError> {
    let shared = Arc::clone(&state.conn);
    let baud = baud.unwrap_or(serial::DEFAULT_BAUD);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = shared.lock().expect("connection lock");
        *guard = None; // release any previous port first
        *guard = Some(Connection::open(&port, baud)?);
        Ok(status_of(&guard))
    })
    .await
    .map_err(|e| TransportError::Io(e.to_string()))?
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Result<(), ()> {
    let shared = Arc::clone(&state.conn);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        shared.lock().expect("connection lock").take();
    })
    .await;
    Ok(())
}

#[tauri::command]
async fn read_servo(state: State<'_, AppState>) -> Result<ReadResult, TransportError> {
    with_connection(&state, |conn| {
        // The servo sometimes ignores the first request(s) after being idle or powered up, so
        // retry a few times. Reads are side-effect free.
        let mut attempt = 0;
        let (reply, _) = loop {
            attempt += 1;
            match conn.transact(&protocol::build_read_frame(), protocol::is_read_reply) {
                Err(TransportError::Timeout(_)) if attempt < READ_ATTEMPTS => continue,
                other => break other?,
            }
        };
        Ok(ReadResult {
            params: protocol::decode(&reply),
            reply: protocol::hex(&reply),
        })
    })
    .await
}

#[tauri::command]
async fn write_servo(
    state: State<'_, AppState>,
    params: ServoParameters,
) -> Result<WriteResult, TransportError> {
    with_connection(&state, move |conn| {
        let frame = protocol::build_write_frame(&params);
        let (reply, _) = conn.transact(&frame, protocol::is_write_ack)?;
        Ok(WriteResult {
            sent: protocol::hex(&frame),
            reply: protocol::hex(&reply),
        })
    })
    .await
}

/// Official Silicon Labs CP210x USB-to-UART driver downloads (Windows; macOS and Linux have
/// built-in drivers).
const DRIVER_URL: &str = "https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers";

/// Opens the CP210x driver download page in the default browser and returns its URL.
#[tauri::command]
fn open_driver_page() -> Result<String, String> {
    let opener = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(DRIVER_URL)
        .spawn()
        .map_err(|e| {
            format!("Could not open a browser ({e}). Download the driver from {DRIVER_URL}")
        })?;
    Ok(DRIVER_URL.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_ports,
            connection_status,
            connect,
            disconnect,
            read_servo,
            write_servo,
            open_driver_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Eclipse30618 Swyft Servo Programmer");
}
