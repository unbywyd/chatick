import { Navigate, Route, Routes } from 'react-router-dom'
import { EmailStep, CodeStep, AuthCallbackV2 } from './Login'
import { InviteV2 } from './Invite'
import { NewCompanyV2 } from './NewCompany'
import { ConsentV2 } from './Consent'
import { AUTH } from './paths'

/**
 * Вход v2 целиком под одним адресом (/login2/*), пока старый вход живёт
 * рядом. Экраны вне шапки компании — каждый оборачивает себя в AuthFrame.
 *
 * Отдельные экраны тоже экспортированы: когда v2 станет основным, их вешают
 * на /login, /auth, /invite/:token и /connect, а адреса меняют в paths.ts.
 */
export function LoginV2() {
  return (
    <Routes>
      <Route index element={<EmailStep />} />
      <Route path="code" element={<CodeStep />} />
      <Route path="new" element={<NewCompanyV2 />} />
      <Route path="auth" element={<AuthCallbackV2 />} />
      <Route path="invite/:token" element={<InviteV2 />} />
      <Route path="consent" element={<ConsentV2 />} />
      <Route path="*" element={<Navigate to={AUTH.login} replace />} />
    </Routes>
  )
}

export { CompaniesV2 } from './Companies'
export { EmailStep as LoginScreenV2, CodeStep as CodeScreenV2, AuthCallbackV2, InviteV2, NewCompanyV2, ConsentV2 }
