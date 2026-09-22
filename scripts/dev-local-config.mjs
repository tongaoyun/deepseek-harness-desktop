export function localDevelopmentPort(value) {
  if (value === undefined || value === '') return 0
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 65535) {
    throw new Error('XIAOYIN_LOCAL_DEV_PORT must be a port between 1 and 65535')
  }
  return Number(value)
}

export function localDevelopmentTauriConfig(url) {
  return {
    productName: '小胤本地测试',
    identifier: 'com.instudio.xiaoyin.desktop.local-test',
    build: { devUrl: url, beforeDevCommand: '' },
    app: { windows: [
      {
        label: 'main', title: '小胤 · 本地测试', width: 1320, height: 820, minWidth: 900, minHeight: 640,
        create: false,
      },
      {
        label: 'erp-login',
        url: 'index.html?window=erp-login',
        title: '小胤 · ERP 扫码登录',
        width: 420,
        height: 540,
        minWidth: 380,
        minHeight: 500,
        center: true,
        visible: false,
        focus: false,
        resizable: false,
        fullscreen: false,
        closable: true,
      },
    ] },
  }
}
