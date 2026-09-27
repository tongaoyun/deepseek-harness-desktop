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
    ] },
  }
}
