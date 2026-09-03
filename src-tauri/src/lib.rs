use serde::Serialize;
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

mod device_identity;
mod erp_auth;
mod expert_kits;
mod harness;
mod harness_connectors;
mod im;
mod local_artifacts;
mod local_files;
mod local_store;
mod memory;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(harness::HarnessManager::default())
        .manage(im::LocalImManager::default())
        .manage(local_files::LocalFileAuthorizations::default())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "打开小胤", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出小胤", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("xiaoyin")
                .menu(&menu)
                .tooltip("小胤")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, tauri::tray::TrayIconEvent::DoubleClick { .. }) {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "erp-login"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            } else if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
                if let Some(login_window) = window.app_handle().get_webview_window("erp-login") {
                    let _ = login_window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            device_identity::inspect_device_identity,
            runtime_info,
            erp_auth::erp_session,
            erp_auth::clear_erp_session,
            erp_auth::open_erp_login,
            erp_auth::erp_qr_login_configuration,
            erp_auth::complete_erp_qr_login,
            expert_kits::list_installed_expert_kits,
            expert_kits::install_expert_kit,
            expert_kits::developer_expert_kit_install_enabled,
            expert_kits::install_developer_extension,
            expert_kits::create_developer_extension,
            expert_kits::read_developer_extension,
            expert_kits::package_developer_extension,
            expert_kits::create_expert_kit_template,
            expert_kits::customize_expert_kit,
            expert_kits::export_expert_kit,
            expert_kits::remove_developer_expert_kit,
            expert_kits::remove_developer_extension,
            expert_kits::remove_catalog_extension,
            local_artifacts::open_local_artifact,
            local_files::authorize_local_directory,
            local_files::authorize_standard_local_directories,
            local_files::authorize_dropped_paths,
            local_files::revoke_local_directory,
            local_files::clear_local_directories,
            local_store::load_local_tasks,
            local_store::save_local_task,
            local_store::delete_local_task,
            local_store::load_enterprise_catalog_cache,
            local_store::save_enterprise_catalog_cache,
            harness::run_harness,
            harness::diagnose_connectors,
            harness::probe_harness_host,
            harness::self_test_local_capabilities,
            harness::cancel_harness,
            harness::shutdown_harness,
            im::configure_local_dingtalk,
            im::start_local_im,
            im::set_local_im_enabled,
            im::local_im_status,
            im::allow_local_im_pairing,
            im::bind_local_im_task,
            im::unbind_local_im_task,
            im::sync_local_im_tasks,
            im::route_local_im_schedule,
            im::stop_local_im_runtime,
            im::remove_local_dingtalk,
            memory::load_memory_profile,
            memory::load_memory_history,
            memory::save_memory_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running Xiaoyin desktop");
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
