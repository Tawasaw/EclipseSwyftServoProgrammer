// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    eclipse30618_swyft_servo_programmer_lib::run();
}
