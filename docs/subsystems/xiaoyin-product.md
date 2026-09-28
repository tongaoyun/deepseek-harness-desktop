# Xiaoyin product

English | [中文](xiaoyin-product.zh.md)

The Xiaoyin product layer adds enterprise capabilities around the official DeepSeek Harness desktop. It owns product data and integrations, while Harness remains the authority for sessions, turns, tools, approvals, conversation rendering, Browser, Office, permissions, and session persistence.

## Product-owned capabilities

- DingTalk OAuth session and employee bootstrap.
- Expert-kit, skill, connector, and knowledge-base catalogs.
- IM and system schedule associations.
- Product references, delivered artifacts, and the restricted Electron bridge.

The product bridge exposes only `invoke`, `subscribe`, and `getSession` to the Renderer. Native filesystem, credentials, SQLite, attachments, and device identity operations stay behind the `xiaoyin.native.v1` sidecar protocol.

## Boundary

Product packages use public Harness package APIs and stable extension points. They do not import private runtime modules, replace the Session Controller, or maintain a second conversation reducer. Product metadata is attached through official Sidebar and Slot extension points.
