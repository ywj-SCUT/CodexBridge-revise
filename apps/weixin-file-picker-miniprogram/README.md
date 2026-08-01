# 微信聊天文件选择小程序

普通网页的 `<input type="file">` 只能打开 Android 系统文件选择器。微信原生的“选择一个聊天”界面由小程序 API `wx.chooseMessageFile` 提供，因此 `/pickfile` 要实现聊天选择必须配置此小程序。

1. 在微信公众平台注册并认证小程序。
2. 复制 `project.config.json.example` 为 `project.config.json`，填写小程序 AppID，用微信开发者工具导入本目录。
3. 为 CodexBridge 上传服务配置公网 HTTPS 域名，在小程序后台把该域名同时加入 `request` 和 `uploadFile` 合法域名。
4. 发布小程序。在 CodexBridge 环境文件中设置小程序 AppID 和 AppSecret：

```text
CODEXBRIDGE_MOBILE_UPLOAD_MINIPROGRAM_APP_ID=wx_your_app_id
CODEXBRIDGE_MOBILE_UPLOAD_MINIPROGRAM_APP_SECRET=your_app_secret
```

重新启动服务后，微信发送 `/pickfile`。CodexBridge 会调用微信 `generate_urllink` API 为本次一次性上传会话生成 URL Link；点击链接进入本小程序，再点击“从微信聊天选择”。小程序调用 `wx.chooseMessageFile`，逐个通过 `wx.uploadFile` 上传，并调用 `/complete` 将附件投递给发起命令的微信会话。

真机发布要求 HTTPS 域名；局域网 HTTP 地址只适合微信开发者工具关闭域名校验后的联调。
