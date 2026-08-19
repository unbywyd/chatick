import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Pencil, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/**
 * Должность участника с подсказкой типовых значений.
 *
 * Список НЕ ограничивает: своё название встречается чаще любого готового,
 * и «Head of nothing in particular» должно вводиться так же свободно, как
 * «Backend developer».
 *
 * Не переводится намеренно. Это поле читает ассистент, и смешение языков в
 * его контексте только мешает: «бэкендер», «Backend developer» и «מפתח
 * בקאנד» — три разных строки для того, кто пытается понять, кто есть кто.
 */
const COMMON_TITLES = [
  'Product owner',
  'Project manager',
  'Team lead',
  'Backend developer',
  'Frontend developer',
  'Full-stack developer',
  'Mobile developer',
  'DevOps engineer',
  'QA engineer',
  'Designer',
  'UX designer',
  'Data analyst',
  'Marketing',
  'Sales',
  'Support',
  'Accountant',
  'Client',
  'Contractor',
]

export function JobTitleField({
  value,
  inherited,
  canEdit,
  onSave,
}: {
  value: string
  /**
   * Значение пришло от компании, а не задано здесь.
   *
   * Показываем это прямо: иначе человек правит унаследованное, думая, что
   * меняет общее, — и получает расхождение там, где хотел единообразия.
   */
  inherited?: boolean
  canEdit: boolean
  onSave: (jobTitle: string) => void
}) {
  const { t } = useTranslation()
  const listId = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  if (!canEdit) {
    return value ? (
      <span className="truncate text-xs text-muted-foreground">{value}</span>
    ) : null
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        className="group/jt flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        title={inherited ? t('jobTitle.inherited') : t('jobTitle.edit')}
      >
        <span className="truncate">{value || t('jobTitle.empty')}</span>
        <Pencil className="size-3 shrink-0 opacity-0 transition-opacity group-hover/jt:opacity-100" />
      </button>
    )
  }

  const commit = () => {
    setEditing(false)
    if (draft.trim() !== value) onSave(draft.trim())
  }

  return (
    <span className="flex items-center gap-1">
      <Input
        autoFocus
        value={draft}
        list={listId}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        placeholder={t('jobTitle.placeholder')}
        className="h-7 w-44 text-xs"
        maxLength={120}
      />
      {/* datalist, а не свой выпадающий список: браузер сам фильтрует по
          набранному и не мешает ввести то, чего в списке нет. */}
      <datalist id={listId}>
        {COMMON_TITLES.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <Button variant="ghost" size="icon" className="size-7" onClick={commit} title={t('common.save')}>
        <Check className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="size-7" onClick={() => setEditing(false)} title={t('common.cancel')}>
        <X className="size-3.5" />
      </Button>
    </span>
  )
}
