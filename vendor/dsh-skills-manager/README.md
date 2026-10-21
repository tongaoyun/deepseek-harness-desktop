# 技能插件

公司桌面预装的独立 Cordis 插件，基于 MichengAI 1.2.9 维护。上游提交及源文件哈希见 [upstream.json](upstream.json)，保留 Apache-2.0 许可和第三方声明。

插件代码随桌面软件构建发布；页面不提供插件独立更新或外部项目入口。原生技能 Provider、加载及设置入口继续保留。

构建：在仓库根目录运行 `pnpm run build:artifacts`。公司分支的完整差异登记在 [vendor/README.md](../README.md)。

启用技能只打开管理开关，继续遵守 `disable-model-invocation` 和 `user-invocable`；停用阻断两类调用，重新启用恢复源文件权限。非法调用声明仍拒绝调用，管理目录保留诊断信息。
