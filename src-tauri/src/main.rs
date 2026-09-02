#![cfg_attr(
    all(
        target_os = "windows",
        any(not(debug_assertions), feature = "windows-no-console")
    ),
    windows_subsystem = "windows"
)]

fn main() {
    xiaoyin_desktop_lib::run();
}
