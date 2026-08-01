Page({
  data: {
    uploadUrl: '',
    ready: false,
    busy: false,
    status: '正在读取上传会话...',
    statusKind: '',
  },

  onLoad(options) {
    const uploadUrl = decodeURIComponent(options.uploadUrl || '');
    const valid = /^https?:\/\//.test(uploadUrl) && /\/mobile-upload\/[a-f0-9]{64}$/.test(uploadUrl);
    this.setData({
      uploadUrl: valid ? uploadUrl : '',
      ready: valid,
      status: valid ? '最多选择 5 个文件，选择后将自动上传。' : '上传链接无效，请回到机器人会话重新发送 /pickfile。',
      statusKind: valid ? '' : 'error',
    });
  },

  chooseAndUpload() {
    wx.chooseMessageFile({
      count: 5,
      type: 'all',
      success: ({ tempFiles }) => this.uploadFiles(tempFiles || []),
      fail: (error) => {
        if (!/cancel/i.test(error.errMsg || '')) this.showError(error.errMsg || '选择文件失败。');
      },
    });
  },

  async uploadFiles(files) {
    if (!files.length) return;
    this.setData({ busy: true, statusKind: '' });
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        this.setData({ status: `正在上传 ${index + 1}/${files.length}：${file.name}` });
        await this.uploadFile(file);
      }
      await this.completeUpload();
      this.setData({ status: '已发送给 Codex，可以返回微信查看进度。', statusKind: 'ok' });
    } catch (error) {
      this.showError(error.message || String(error));
    } finally {
      this.setData({ busy: false });
    }
  },

  uploadFile(file) {
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: `${this.data.uploadUrl}/files?name=${encodeURIComponent(file.name || 'upload.bin')}`,
        filePath: file.path,
        name: 'file',
        success: ({ statusCode, data }) => {
          const body = this.parseResponse(data);
          if (statusCode >= 200 && statusCode < 300) resolve(body);
          else reject(new Error(body.error || `上传失败（${statusCode}）`));
        },
        fail: (error) => reject(new Error(error.errMsg || '上传失败。')),
      });
    });
  },

  completeUpload() {
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${this.data.uploadUrl}/complete`,
        method: 'POST',
        success: ({ statusCode, data }) => {
          const body = typeof data === 'string' ? this.parseResponse(data) : data;
          if (statusCode >= 200 && statusCode < 300) resolve(body);
          else reject(new Error((body && body.error) || `提交失败（${statusCode}）`));
        },
        fail: (error) => reject(new Error(error.errMsg || '提交失败。')),
      });
    });
  },

  parseResponse(data) {
    try {
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      return {};
    }
  },

  showError(message) {
    this.setData({ status: message, statusKind: 'error' });
  },
});
