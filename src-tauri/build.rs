const APP_COMMANDS: &[&str] = &[
    "attachment_storage",
    "inspect_device_identity",
    "load_connector_secrets",
    "connector_authorization",
    "task_write_operations",
    "save_connector_secret",
    "delete_connector_secret",
    "runtime_info",
    "dingtalk_session",
    "clear_dingtalk_session",
    "open_dingtalk_login",
    "list_installed_expert_kits",
    "install_expert_kit",
    "inspect_github_skills",
    "install_github_skill",
    "html_artifact_preview_url",
    "install_developer_extension",
    "select_developer_extension",
    "create_developer_extension",
    "read_developer_extension",
    "read_extension_contents",
    "set_extension_enabled",
    "reveal_extension_directory",
    "package_developer_extension",
    "customize_expert_kit",
    "export_expert_kit",
    "remove_developer_expert_kit",
    "remove_developer_extension",
    "remove_catalog_extension",
    "read_local_artifact_preview",
    "read_harness_image_preview",
    "reveal_local_artifact",
    "open_local_artifact",
    "undo_local_file_change",
    "authorize_local_directory",
    "authorize_local_files",
    "import_pasted_image",
    "import_pasted_file",
    "clipboard_file_paths",
    "read_feedback_image",
    "authorize_standard_local_directories",
    "authorize_dropped_paths",
    "restore_local_directories",
    "revoke_local_directory",
    "clear_local_directories",
    "load_local_tasks",
    "load_local_task",
    "save_local_task",
    "append_local_task_capability_notice",
    "delete_local_task",
    "load_enterprise_catalog_cache",
    "save_enterprise_catalog_cache",
    "load_local_schedules",
    "save_local_schedules",
    "load_local_task_queues",
    "save_local_task_queues",
    "load_local_workspace_state",
    "save_local_workspace_state",
    "run_harness",
    "diagnose_connectors",
    "probe_harness_host",
    "check_harness_provider",
    "inspect_harness_session",
    "search_harness_sessions",
    "self_test_local_capabilities",
    "cancel_harness",
    "steer_harness",
    "interrupt_harness",
    "fork_harness",
    "respond_harness_approval",
    "respond_harness_question",
    "schedule_keep_awake",
    "shutdown_harness",
    "configure_local_dingtalk",
    "start_local_im",
    "set_local_im_enabled",
    "local_im_status",
    "allow_local_im_pairing",
    "begin_dingtalk_registration",
    "poll_dingtalk_registration",
    "revoke_local_im_pairing",
    "bind_local_im_task",
    "unbind_local_im_task",
    "retry_local_im_delivery",
    "sync_local_im_tasks",
    "route_local_im_schedule",
    "stop_local_im_runtime",
    "remove_local_dingtalk",
    "load_memory_profile",
    "load_memory_history",
    "save_memory_profile",
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.ends_with("windows-msvc") {
        // Tauri's resources target application bins; unit-test executables need v6 too.
        tauri_build::try_build(
            attributes
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
        )
        .expect("Unable to build Windows resources");
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    } else {
        tauri_build::try_build(attributes).expect("Unable to build Tauri application metadata")
    }
}
