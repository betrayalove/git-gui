import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { language } from '../../shared/i18n'
import { App } from './App'
import './styles.css'

document.documentElement.lang = language()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
