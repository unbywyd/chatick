import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, projects, users } from '../db/schema.js'
import { mailLang, type MailLang } from './mail-template.js'

// На каком языке писать человеку (SPEC §8.39).
//
// Раньше язык брался только из личных настроек получателя, а у приглашения —
// из настроек приглашающего. У человека, которого ещё нет в системе, настроек
// нет вовсе: израильская компания заводила сотрудника, а письмо уходило
// по-английски.
//
// Порядок такой:
//   1. личный язык человека — он выбрал его сам, это сильнее любых умолчаний;
//   2. язык проекта — если письмо про конкретный проект;
//   3. язык компании;
//   4. английский.

/** Язык проекта с наследованием от компании. */
export async function projectLocale(projectId: string): Promise<MailLang> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return 'en'
  if (project.locale) return mailLang(project.locale)
  const company = await db.query.companies.findFirst({ where: eq(companies.id, project.companyId) })
  return mailLang(company?.locale)
}

export async function companyLocale(companyId: string): Promise<MailLang> {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  return mailLang(company?.locale)
}

/**
 * Язык письма получателю.
 *
 * @param userId — кому пишем. Его собственная настройка важнее всего: человек
 *   мог осознанно выбрать язык, отличный от языка фирмы.
 */
export async function localeFor(opts: {
  userId?: string | null
  projectId?: string | null
  companyId?: string | null
}): Promise<MailLang> {
  if (opts.userId) {
    const user = await db.query.users.findFirst({ where: eq(users.id, opts.userId) })
    // Пустая строка и 'en' по умолчанию — не одно и то же с осознанным
    // выбором, но различить их в текущей схеме нельзя: колонка не пустая.
    // Поэтому личный язык считаем выбором, если он вообще задан.
    if (user?.locale) return mailLang(user.locale)
  }
  if (opts.projectId) return projectLocale(opts.projectId)
  if (opts.companyId) return companyLocale(opts.companyId)
  return 'en'
}
