//! Hardware diagnostic: sends READ requests back-to-back for a while and reports any reply or stray
//! bytes, e.g. while power-cycling the servo to catch a short power-up programming window.
//! Never writes parameters.
//!
//!     cargo run --example listen [PORT] [INTERVAL_MS] [SECONDS]

use eclipse30618_swyft_servo_programmer_lib::{protocol, serial};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

fn main() {
    let mut args = std::env::args().skip(1);
    let port = args.next().filter(|s| s != "-").unwrap_or_else(|| {
        serial::list_ports()
            .first()
            .expect("no serial ports")
            .name
            .clone()
    });
    let interval = Duration::from_millis(args.next().and_then(|s| s.parse().ok()).unwrap_or(15));
    let seconds = args.next().and_then(|s| s.parse().ok()).unwrap_or(60u64);

    let mut p = serialport::new(&port, serial::DEFAULT_BAUD)
        .stop_bits(serialport::StopBits::Two)
        .timeout(Duration::from_millis(1))
        .open()
        .expect("open port");
    let req = protocol::build_read_frame();
    println!("listening on {port}: READ every {interval:?} for {seconds}s");

    let start = Instant::now();
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 512];
    let (mut sent, mut echoes, mut stray) = (0usize, 0usize, 0usize);
    let mut quiet_since: Option<Instant> = None; // set while even our echo is missing
    let mut last_echo = Instant::now();
    let mut next_send = Instant::now();

    while start.elapsed() < Duration::from_secs(seconds) {
        if Instant::now() >= next_send {
            p.write_all(&req).expect("write");
            sent += 1;
            next_send += interval;
        }
        if let Ok(n) = p.read(&mut chunk) {
            buf.extend_from_slice(&chunk[..n]);
        }
        let ms = start.elapsed().as_millis();

        if let Some(reply) = protocol::find_frame(&buf, protocol::is_read_reply) {
            println!("[{ms:>6}ms] *** VALID REPLY *** {}", protocol::hex(&reply));
            println!("{:#?}", protocol::decode(&reply));
            return;
        }

        // Strip our own echoes; anything else that piles up is stray traffic from the servo.
        while let Some(pos) = buf.windows(20).position(|w| w == req) {
            if pos > 0 {
                stray += pos;
                println!("[{ms:>6}ms] stray bytes: {}", protocol::hex(&buf[..pos]));
            }
            buf.drain(..pos + 20);
            echoes += 1;
            last_echo = Instant::now();
            if let Some(t) = quiet_since.take() {
                println!(
                    "[{ms:>6}ms] echo resumed after {}ms gap",
                    t.elapsed().as_millis()
                );
            }
        }
        if buf.len() > 60 {
            stray += buf.len() - 20;
            println!(
                "[{ms:>6}ms] stray bytes: {}",
                protocol::hex(&buf[..buf.len() - 20])
            );
            buf.drain(..buf.len() - 20);
        }
        if last_echo.elapsed() > Duration::from_millis(100) && quiet_since.is_none() {
            quiet_since = Some(last_echo);
            println!("[{ms:>6}ms] echo stopped (line disturbed)");
        }
    }
    println!("done: {sent} requests, {echoes} clean echoes, {stray} stray bytes, no valid reply");
}
