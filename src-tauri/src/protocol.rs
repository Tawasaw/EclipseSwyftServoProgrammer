//! The 20-byte single-wire UART frame format used by the servo.
//!
//! Frame layout (all frames are exactly [`FRAME_LEN`] bytes):
//!   [0]      Header,  always 0x55
//!   [1..17]  17-byte payload
//!   [18]     Checksum = (sum of bytes 1..17) & 0xFF
//!   [19]     Footer,  always 0xAA
//!
//! Payload layout:
//!   [1]      Torque proportion (P)           u8
//!   [2]      Integral proportion (I)         u8
//!   [3]      Flags (see FLAG_*)              u8
//!   [4]      Angle proportion, max side      u8  ("Left range")
//!   [5]      Sensitivity (dead zone)         u8
//!   [6]      Integral speed (x3 ms)          u8
//!   [7,8]    Brake proportion (D)            u16 LE
//!   [9,10]   Min pulse width (us)            u16 LE
//!   [11,12]  Max pulse width (us)            u16 LE
//!   [13,14]  Max duty cycle (power)          u16 LE
//!   [15]     Angle proportion, min side      u8  ("Right range")
//!   [16,17]  Center / median pulse (us)      u16 LE

use serde::{Deserialize, Serialize};

pub const FRAME_LEN: usize = 20;
pub const HEADER: u8 = 0x55;
pub const FOOTER: u8 = 0xAA;

pub const FLAG_DIRECTION_REVERSE: u8 = 0x01;
pub const FLAG_WRITE_REQUEST: u8 = 0x02;
pub const FLAG_WRITE_ACK: u8 = 0x04;
pub const FLAG_READ_VALID: u8 = 0x08;
pub const FLAG_STALL_PROTECTION: u8 = 0x10;
pub const FLAG_SOFT_START: u8 = 0x20;

pub type Frame = [u8; FRAME_LEN];

/// Raw servo parameters exactly as stored in the firmware.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServoParameters {
    pub torque: u8,
    pub integral_proportion: u8,
    pub big_angle: u8,
    pub small_angle: u8,
    pub sensitivity: u8,
    pub integral_speed: u8,
    pub brake: u16,
    pub min_pulse: u16,
    pub max_pulse: u16,
    pub max_duty: u16,
    pub center: u16,
    pub direction_reverse: bool,
    pub stall_protection: bool,
    pub soft_start: bool,
}

pub fn checksum(frame: &[u8]) -> u8 {
    frame[1..18].iter().fold(0u8, |acc, b| acc.wrapping_add(*b))
}

pub fn build_read_frame() -> Frame {
    // Header + footer with an all-zero payload and zero checksum, exactly like the original tool.
    let mut b = [0u8; FRAME_LEN];
    b[0] = HEADER;
    b[19] = FOOTER;
    b
}

pub fn build_write_frame(p: &ServoParameters) -> Frame {
    let mut b = [0u8; FRAME_LEN];
    b[0] = HEADER;
    b[1] = p.torque;
    b[2] = p.integral_proportion;
    let mut flags = FLAG_WRITE_REQUEST;
    if p.direction_reverse {
        flags |= FLAG_DIRECTION_REVERSE;
    }
    if p.stall_protection {
        flags |= FLAG_STALL_PROTECTION;
    }
    if p.soft_start {
        flags |= FLAG_SOFT_START;
    }
    b[3] = flags;
    b[4] = p.big_angle;
    b[5] = p.sensitivity;
    b[6] = p.integral_speed;
    b[7..9].copy_from_slice(&p.brake.to_le_bytes());
    b[9..11].copy_from_slice(&p.min_pulse.to_le_bytes());
    b[11..13].copy_from_slice(&p.max_pulse.to_le_bytes());
    b[13..15].copy_from_slice(&p.max_duty.to_le_bytes());
    b[15] = p.small_angle;
    b[16..18].copy_from_slice(&p.center.to_le_bytes());
    b[18] = checksum(&b);
    b[19] = FOOTER;
    b
}

pub fn is_valid_frame(f: &[u8]) -> bool {
    f.len() >= FRAME_LEN && f[0] == HEADER && f[19] == FOOTER && f[18] == checksum(f)
}

pub fn is_read_reply(f: &[u8]) -> bool {
    is_valid_frame(f) && f[3] & FLAG_READ_VALID != 0
}

pub fn is_write_ack(f: &[u8]) -> bool {
    is_valid_frame(f) && f[3] & FLAG_WRITE_ACK != 0
}

pub fn decode(f: &[u8]) -> ServoParameters {
    let u16le = |i: usize| u16::from_le_bytes([f[i], f[i + 1]]);
    ServoParameters {
        torque: f[1],
        integral_proportion: f[2],
        direction_reverse: f[3] & FLAG_DIRECTION_REVERSE != 0,
        stall_protection: f[3] & FLAG_STALL_PROTECTION != 0,
        soft_start: f[3] & FLAG_SOFT_START != 0,
        big_angle: f[4],
        sensitivity: f[5],
        integral_speed: f[6],
        brake: u16le(7),
        min_pulse: u16le(9),
        max_pulse: u16le(11),
        max_duty: u16le(13),
        small_angle: f[15],
        center: u16le(16),
    }
}

/// Scans a byte stream for the first 20-byte window satisfying `accept`.
///
/// On a single-wire link the host's own transmission is echoed back ahead of the reply. Rather than
/// sleeping and discarding (which races a fast servo), we scan everything received. The echo of a
/// read request lacks the read-valid bit and the echo of a write lacks the write-ack bit, so neither
/// is ever mistaken for a reply.
pub fn find_frame(buf: &[u8], accept: impl Fn(&[u8]) -> bool) -> Option<Frame> {
    if buf.len() < FRAME_LEN {
        return None;
    }
    (0..=buf.len() - FRAME_LEN)
        .map(|i| &buf[i..i + FRAME_LEN])
        .find(|w| accept(w))
        .map(|w| w.try_into().expect("window is FRAME_LEN"))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> ServoParameters {
        ServoParameters {
            torque: 19,
            integral_proportion: 13,
            big_angle: 111,
            small_angle: 111,
            sensitivity: 5,
            integral_speed: 20,
            brake: 47,
            min_pulse: 500,
            max_pulse: 2500,
            max_duty: 400,
            center: 1500,
            direction_reverse: true,
            stall_protection: true,
            soft_start: true,
        }
    }

    #[test]
    fn write_frame_layout() {
        let f = build_write_frame(&defaults());
        assert_eq!(f[0], HEADER);
        assert_eq!(f[19], FOOTER);
        assert_eq!(f[3], FLAG_WRITE_REQUEST | 0x01 | 0x10 | 0x20);
        assert_eq!(&f[9..11], &500u16.to_le_bytes());
        assert_eq!(&f[16..18], &1500u16.to_le_bytes());
        assert!(is_valid_frame(&f));
        assert!(!is_write_ack(&f));
        assert!(!is_read_reply(&f));
    }

    #[test]
    fn roundtrip() {
        let p = defaults();
        assert_eq!(decode(&build_write_frame(&p)), p);
    }

    #[test]
    fn read_request_echo_is_not_a_reply() {
        let f = build_read_frame();
        assert!(is_valid_frame(&f));
        assert!(!is_read_reply(&f));
    }

    #[test]
    fn finds_reply_after_echo_and_noise() {
        let mut reply = build_write_frame(&defaults());
        reply[3] = (reply[3] & !FLAG_WRITE_REQUEST) | FLAG_READ_VALID;
        reply[18] = checksum(&reply);
        let mut stream = vec![0x00, 0xFF];
        stream.extend_from_slice(&build_read_frame());
        stream.push(0x13);
        stream.extend_from_slice(&reply);
        let found = find_frame(&stream, is_read_reply).expect("reply");
        assert_eq!(found, reply);
        assert_eq!(decode(&found), defaults());
    }
}
