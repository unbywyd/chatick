import { describe, it, expect, vi, beforeEach } from 'vitest'

// Своя почта компании: проверяем обращение с секретами и отправку.
//
// Здесь лежит пароль от почты компании — им шлют письма от её имени. Поэтому
// проверяем не «работает ли отправка», а то, что секрет не утекает и что
// сломанные настройки не роняют письма молча.

vi.mock('../env.js', () => ({
  env: { ENCRYPTION_KEY: 'a'.repeat(64), SMTP_HOST: '', SMTP_USER: '' },
  isProd: false,
}))

const sendMailMock = vi.fn()
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock, close: vi.fn() }) },
}))

const rows = new Map<string, Record<string, unknown>>()
vi.mock('../db/client.js', () => ({
  db: {
    query: { companies: { findFirst: async ({ where }: any) => rows.get(where?.__id ?? 'c1') ?? null } },
  },
}))
vi.mock('drizzle-orm', () => ({ eq: (_col: unknown, v: string) => ({ __id: v }) }))
vi.mock('../db/schema.js', () => ({ companies: { id: 'id' } }))

const { encrypt } = await import('./crypto.js')
const { companyMail, sendVia } = await import('./company-mail.js')

const smtpRow = (over: Record<string, unknown> = {}) => ({
  mailProvider: 'smtp',
  mailFromEmail: 'noreply@atlas.com',
  mailFromName: 'Atlas',
  mailReplyTo: null,
  mailHost: 'smtp.atlas.com',
  mailPort: 587,
  mailUser: 'atlas',
  mailPasswordEnc: encrypt('s3cret'),
  mailApiKeyEnc: null,
  ...over,
})

beforeEach(() => {
  rows.clear()
  sendMailMock.mockReset()
  vi.unstubAllGlobals()
})

describe('companyMail — чтение настроек', () => {
  it('расшифровывает пароль для отправки', async () => {
    rows.set('c1', smtpRow())
    const m = await companyMail('c1')
    expect(m?.password).toBe('s3cret')
    expect(m?.provider).toBe('smtp')
  })

  it('без провайдера — общая почта', async () => {
    rows.set('c1', smtpRow({ mailProvider: null }))
    expect(await companyMail('c1')).toBeNull()
  })

  // Половинчатая настройка хуже отсутствующей: письма молча не уходят.
  it('SMTP без пароля или хоста не считается настроенным', async () => {
    rows.set('c1', smtpRow({ mailPasswordEnc: null }))
    expect(await companyMail('c1')).toBeNull()
    rows.set('c1', smtpRow({ mailHost: null }))
    expect(await companyMail('c1')).toBeNull()
  })

  it('SendGrid без ключа не считается настроенным', async () => {
    rows.set('c1', smtpRow({ mailProvider: 'sendgrid', mailApiKeyEnc: null, mailPasswordEnc: null }))
    expect(await companyMail('c1')).toBeNull()
  })

  // Подмена шифротекста в БД должна ломать расшифровку (GCM это ловит), а не
  // выдавать мусор в качестве пароля.
  it('битый шифротекст не роняет отправку, а отключает свою почту', async () => {
    rows.set('c1', smtpRow({ mailPasswordEnc: 'not-a-real-ciphertext' }))
    expect(await companyMail('c1')).toBeNull()
  })
})

describe('sendVia — SMTP', () => {
  it('письмо уходит от имени компании', async () => {
    rows.set('c1', smtpRow())
    const m = (await companyMail('c1'))!
    await sendVia(m, { to: 'tal@atlas.com', subject: 'Hi', text: 'body' }, 'c1')

    const arg = sendMailMock.mock.calls[0]![0]
    expect(arg.from).toEqual({ name: 'Atlas', address: 'noreply@atlas.com' })
    expect(arg.to).toBe('tal@atlas.com')
    // Явная кодировка: без неё кириллица и иврит приходят ромбами.
    expect(arg.textEncoding).toBe('base64')
  })
})

describe('sendVia — SendGrid', () => {
  const sgRow = () => ({
    ...smtpRow(),
    mailProvider: 'sendgrid',
    mailPasswordEnc: null,
    mailApiKeyEnc: encrypt('SG.key'),
  })

  it('ключ уходит в заголовке, а не в теле запроса', async () => {
    rows.set('c1', sgRow())
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)

    const m = (await companyMail('c1'))!
    await sendVia(m, { to: 'tal@atlas.com', subject: 'Hi', text: 'body' }, 'c1')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer SG.key')
    expect(String(init.body)).not.toContain('SG.key')
  })

  // «Не отправилось» не чинится, а «неверный ключ» — чинится сразу.
  it('причина отказа доходит до человека', async () => {
    rows.set('c1', sgRow())
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ errors: [{ message: 'The provided authorization grant is invalid' }] }), {
            status: 401,
          }),
      ),
    )
    const m = (await companyMail('c1'))!
    await expect(sendVia(m, { to: 'a@b.com', subject: 's', text: 't' }, 'c1')).rejects.toThrow(/authorization grant/)
  })
})
