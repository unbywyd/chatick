import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import './index.css'
import './i18n'
import { ThemeProvider } from './providers/theme'
import { ProjectScreen } from './screens/ProjectScreen'
import { LoginScreen, AuthCallback } from './screens/LoginScreen'
import { StartScreen } from './screens/StartScreen'

// HashRouter — единый роутинг для веба и Electron (file://) без доп. настроек.
const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <Routes>
            <Route path="/" element={<LoginScreen />} />
            <Route path="/login" element={<LoginScreen />} />
            <Route path="/auth" element={<AuthCallback />} />
            <Route path="/start" element={<StartScreen />} />
            <Route path="/p/:id" element={<ProjectScreen />} />
          </Routes>
        </HashRouter>
        <Toaster richColors position="top-right" />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
