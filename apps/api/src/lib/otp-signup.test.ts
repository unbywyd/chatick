import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Регистрация по коду на почту.
//
// Раньше код уходил только тем, кто уже есть в системе, а остальным форма
// отвечала «код отправлен» и не отправляла ничего. Microsoft забраковала на
// этом сертификацию: рецензент ввёл свою почту, увидел «check your inbox» и
// не дождался письма — для него функция просто сломана.
//
// Здесь проверяется не «создаётся ли аккаунт», а то, что путь регистрации не
// ломает вход остальным и не открывает дыр: аккаунт заводится только после
// подтверждения почты, служебный вход никого не регистрирует, а код не сгорает
// раньше, чем человек успел заполнить имя.

const here = import.meta.dirname
const route = readFileSync(join(here, '../routes/auth.ts'), 'utf8')
const otp = readFileSync(join(here, 'otp.ts'), 'utf8')
const screen = readFileSync(join(here, '../../../app/src/screens/LoginScreen.tsx'), 'utf8')

const request = route.slice(route.indexOf("auth.post('/otp/request'"), route.indexOf("auth.post('/otp/verify'"))
const verify = route.slice(route.indexOf("auth.post('/otp/verify'"), route.indexOf("auth.post('/desktop'"))

describe('код уходит и незнакомому адресу', () => {
  it('отсутствие аккаунта больше не обрывает отправку', () => {
    // Раньше здесь стоял ранний возврат `if (!user) return c.json(answer)` —
    // именно он и делал кнопку «сломанной».
    expect(request).not.toMatch(/if \(!user\) return c\.json\(answer\)/)
  })

  it('письмо отправляется без падения на пустом языке', () => {
    // У нового человека locale ещё нет: обращение к user.locale уронило бы
    // ручку 500-й ровно на регистрации.
    expect(request).toMatch(/sendLoginCode\(email, user\?\.locale \?\? null, support\)/)
  })

  it('форма узнаёт, что адрес новый', () => {
    expect(request).toMatch(/isNew: !user/)
  })
})

describe('аккаунт создаётся только после подтверждения почты', () => {
  it('в запросе кода записи в users нет', () => {
    // Иначе перебор адресов набил бы базу неподтверждёнными пустышками.
    expect(request).not.toMatch(/insert\(users\)/)
  })

  it('в проверке кода — есть', () => {
    expect(verify).toMatch(/insert\(users\)/)
  })

  it('о регистрации сообщают так же, как о входе через Google', () => {
    expect(verify).toMatch(/notifySignup/)
  })
})

describe('код не сгорает раньше, чем человек успел заполнить имя', () => {
  // Самое хрупкое место. Верный код удаляется из памяти при первой же
  // проверке, поэтому «сначала проверить код, потом спросить имя» означало бы
  // «код истёк» для каждого, кто регистрируется.
  it('поля регистрации проверяются ДО кода', () => {
    const signupCheck = verify.indexOf('signup_required')
    const codeCheck = verify.indexOf('verifyLoginCode(email, code)')
    expect(signupCheck).toBeGreaterThan(-1)
    expect(codeCheck).toBeGreaterThan(-1)
    expect(signupCheck).toBeLessThan(codeCheck)
  })

  it('верный код действительно одноразовый — потому порядок и важен', () => {
    const v = otp.slice(otp.indexOf('export function verifyLoginCode'))
    expect(v).toMatch(/codes\.delete\(key\)\s*\n\s*return 'ok'/)
  })

  it('форма не тратит код на заведомо неполные данные', () => {
    expect(screen).toMatch(/if \(signup && \(!otpName\.trim\(\) \|\| !otpTerms\)\)/)
  })
})

describe('регистрация требует имени и согласия', () => {
  it('без них — 422 с признаком для формы', () => {
    expect(verify).toMatch(/code: 'signup_required'/)
    expect(verify).toMatch(/422,/)
  })

  it('форма по этому признаку показывает поля, а не ошибку', () => {
    expect(screen).toMatch(/e\.status === 422/)
    expect(screen).toMatch(/setSignup\(true\)/)
  })

  it('согласие — именно галочка, а не любое непустое значение', () => {
    expect(verify).toMatch(/body\.acceptTerms === true/)
  })

  it('ссылки на условия и политику ведут на живые страницы', () => {
    expect(screen).toMatch(/chatick\.com\/terms\//)
    expect(screen).toMatch(/chatick\.com\/privacy\//)
  })
})

describe('служебный вход никого не регистрирует', () => {
  // «почта:dev» открывает ЧУЖОЙ аккаунт для разбора проблем. Заводить им
  // новых людей — значит превратить механизм поддержки в способ создавать
  // аккаунты на чужие адреса.
  it('запрос кода под незнакомым адресом ничего не шлёт', () => {
    expect(request).toMatch(/if \(support && !user\)/)
  })

  it('проверка кода под незнакомым адресом не создаёт человека', () => {
    const create = verify.slice(verify.indexOf('if (!user) {'))
    expect(create.slice(0, create.indexOf('insert(users)'))).toMatch(/if \(support\) return/)
  })
})

describe('человек не остаётся без объяснения', () => {
  it('до нажатия сказано, что код заведёт аккаунт', () => {
    expect(screen).toMatch(/login\.otpNewHint/)
  })

  it('и после — что именно происходит', () => {
    expect(screen).toMatch(/login\.otpSignupHint/)
  })
})
