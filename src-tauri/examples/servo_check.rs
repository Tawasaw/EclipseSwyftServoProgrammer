//! Hardware smoke test: lists ports, then performs a single READ on the best candidate (or the port
//! given as the first argument). Never writes to the servo.
//!
//!     cargo run --example servo_check [PORT]

use eclipse30618_swyft_servo_programmer_lib::{protocol, serial};

fn main() {
    let ports = serial::list_ports();
    for p in &ports {
        println!("{:>5}  {}  {}", p.score, p.name, p.description);
    }
    let name = std::env::args()
        .nth(1)
        .or_else(|| ports.first().map(|p| p.name.clone()))
        .expect("no serial ports found");
    println!("\nReading from {name} …");
    let mut conn = serial::Connection::open(&name, serial::DEFAULT_BAUD).expect("open");
    let mut result = conn.transact(&protocol::build_read_frame(), protocol::is_read_reply);
    for _ in 1..4 {
        if result.is_ok() {
            break;
        }
        result = conn.transact(&protocol::build_read_frame(), protocol::is_read_reply);
    }
    match result {
        Ok((reply, raw)) => {
            println!("raw rx: {}", protocol::hex(&raw));
            println!("reply : {}", protocol::hex(&reply));
            println!("{:#?}", protocol::decode(&reply));
        }
        Err(e) => {
            eprintln!("read failed: {e:?}");
            std::process::exit(1);
        }
    }
}
