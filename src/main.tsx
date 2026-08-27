import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import App from './App'
import { ErpQrLoginWindow } from './ErpQrLoginWindow'
import { isTauriRuntime } from './auth'
import './styles.css'

const nativeLabel = isTauriRuntime() ? getCurrentWindow().label : ''
const isLoginWindow = nativeLabel === 'erp-login' || new URLSearchParams(window.location.search).get('window') === 'erp-login'
if (isLoginWindow) document.body.classList.add('erp-login-body')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isLoginWindow ? <ErpQrLoginWindow /> : <App />}</StrictMode>,
)
