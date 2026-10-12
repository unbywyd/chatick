import { letterOf, projectColor } from './util'

/**
 * Значок проекта: логотип, если загружен, иначе первая буква на цвете
 * проекта. Логотип узнаётся быстрее буквы — у многих проектов имя начинается
 * на иврите, и одна буква их не различает.
 */
export function ProjectLogo({
  project,
  size = 'sm',
  title,
}: {
  project: { id: string; name: string; color: string | null; logoUrl?: string | null } | null | undefined
  size?: 'sm' | 'xs' | 'md'
  title?: string
}) {
  const cls = 'logo' + (size === 'md' ? '' : ' ' + size)
  if (project?.logoUrl)
    return (
      <span className={cls} title={title} style={{ background: 'var(--sheet)', overflow: 'hidden', padding: 0 }}>
        <img src={project.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </span>
    )
  return (
    <span className={cls} title={title} style={{ background: projectColor(project) }}>
      {letterOf(project?.name)}
    </span>
  )
}
