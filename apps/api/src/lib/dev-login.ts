/**
 * Вход разработчика без кода — для проверки клиента на копии базы.
 *
 * Код на почту локально не дойдёт (SMTP выключен намеренно: копия базы — это
 * настоящие адреса людей, и письмо ушло бы им). Без входа клиент v2 нельзя
 * проверить вовсе, а «войти как я» на проде — дверь во все аккаунты.
 *
 * Поэтому условий четыре, и нужны ВСЕ:
 *   1. флаг DEV_LOGIN=1 — по умолчанию его нет;
 *   2. не production;
 *   3. база — копия (_dev, _staging, _check_*), а не боевая;
 *   4. запрос с этой же машины (localhost).
 * Любое одно может однажды сломаться по ошибке — четыре сразу нет.
 */
export function devLoginAllowed(i: { flag?: string; nodeEnv: string; databaseUrl: string; host?: string | null }): boolean {
  if (i.flag !== '1') return false
  if (i.nodeEnv === 'production') return false
  const dbName = /\/([^/?]+)(\?|$)/.exec(i.databaseUrl.replace(/^[a-z]+:\/\/[^/]*/i, ''))?.[1] ?? ''
  if (!/(_dev|_staging|_check_[a-z0-9_]+)$/i.test(dbName)) return false
  const host = (i.host ?? '').toLowerCase().replace(/:\d+$/, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}
