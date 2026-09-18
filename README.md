# MyAIUI2

面向 Windows 内网环境的轻量本地 AI 对话桌面应用规划仓库。

当前阶段只完成了方案设计与仓库初始化，尚未开始产品代码开发。详细实施方案见：

- [实施方案与任务拆解](docs/IMPLEMENTATION_PLAN.md)

## 已确定的产品边界

- 只保留对话工作台；设置使用抽屉或弹窗，不增加独立业务页面。
- 支持添加助手、新建话题、配置模型服务、同步模型、纯文字对话、联网搜索、展示模型返回的图片。
- 禁止文件选择、文件拖放、文件/图片粘贴、附件上传、文档处理、知识库、MCP、智能体、频道、应用、OpenClaw 和 API Server。
- Go/Wails 只负责桌面壳、本地持久化、密钥保护和受限网络传输；模型协议与消息编排位于 React 前端的 Vercel AI SDK 适配层。

## 参考项目

实际找到的 Cherry Studio 源码目录为：

`D:\WorkProject\3rd_github\Group_cli_agent\cherry-studio`

规划审查基线：`f236b74929f1683a23b3a808f57e5a9d53f0b1e8`（2026-09-18）。
