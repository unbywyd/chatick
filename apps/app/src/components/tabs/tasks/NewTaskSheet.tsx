import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DatePicker } from '@/components/ui/date-picker'

/**
 * Создание задачи на телефоне.
 *
 * В шапке страницы форма стоит строкой: спринт, название, срок, «Создать»,
 * меню. На 400px названию оставалось два сантиметра — человек печатал вслепую,
 * не видя, что набрал. Ужимать эту строку бесполезно: пять элементов в ряд на
 * телефоне не помещаются никогда.
 *
 * Поэтому на телефоне форма уезжает целиком, а вместо неё — кнопка, которая
 * открывает лист снизу. Там у названия вся ширина экрана, и видно, что пишешь.
 *
 * Лист снизу, а не окно по центру: клавиатура выезжает снизу и накрывает
 * нижнюю половину экрана. Окно по центру она закрыла бы наполовину — вместе с
 * полем, ради которого его открыли.
 */
export function NewTaskSheet({
  open,
  onClose,
  onCreate,
  pending,
  groups,
  groupId,
  onGroupChange,
}: {
  open: boolean
  onClose: () => void
  onCreate: (title: string, due: string) => void
  pending: boolean
  groups: { id: string; name: string; color: string }[]
  groupId: string | null
  onGroupChange: (id: string | null) => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * Фокус в поле сразу при открытии.
   *
   * Иначе человек делает лишнее касание, а на телефоне это ещё и ожидание:
   * клавиатура выезжает только после него.
   *
   * Задержка в кадр: до неё элемента ещё нет в разметке, и focus() уходит в
   * пустоту.
   */
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  /** Закрыли — забываем набранное: лист открывают под новую задачу. */
  useEffect(() => {
    if (!open) {
      setTitle('')
      setDue('')
    }
  }, [open])

  // Escape закрывает: на телефоне это внешняя клавиатура, на планшете обычное
  // дело. Клик мимо тоже закрывает — обработчик на подложке.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const submit = () => {
    const name = title.trim()
    if (!name) return
    onCreate(name, due)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50 sm:hidden"
      onClick={onClose}
    >
      <div
        // pb с safe-area: у телефонов без кнопки «домой» внизу полоса жеста,
        // и кнопка «Создать» попадала бы прямо под неё.
        className="max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('tasks.newTask')}</h2>
          <button
            onClick={onClose}
            aria-label={t('common.cancel')}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <Input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('tasks.newPlaceholder')}
          // Enter создаёт — на телефонной клавиатуре это кнопка «готово», и
          // тянуться к «Создать» не нужно.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          className="w-full"
        />

        <div className="mt-3 space-y-3">
          <DatePicker value={due} onChange={setDue} placeholder={t('tasks.dueNone')} className="w-full" />

          {/* Спринт — только если он в проекте есть. Пустой выбор занимал бы
              место и ничего не предлагал. */}
          {groups.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => onGroupChange(null)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs transition-colors',
                  !groupId ? 'border-brand bg-brand/10 text-brand-ink' : 'text-muted-foreground',
                )}
              >
                {t('tasks.noGroup')}
              </button>
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onGroupChange(g.id)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
                    groupId === g.id ? 'border-brand bg-brand/10 text-brand-ink' : 'text-muted-foreground',
                  )}
                >
                  <span className="size-2 rounded-full" style={{ backgroundColor: g.color }} />
                  <span className="max-w-28 truncate">{g.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <Button
          variant="brand"
          onClick={submit}
          disabled={!title.trim() || pending}
          className="mt-4 w-full"
        >
          <Plus className="size-4" />
          {t('start.create')}
        </Button>
      </div>
    </div>
  )
}
