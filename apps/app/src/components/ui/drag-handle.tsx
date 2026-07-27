import { GripVertical } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/**
 * Значок «это можно перетащить» — для файлов, документов, заметок и ресурсов.
 *
 * Сама по себе карточка ничем не выдаёт, что её тянут в чат: узнать об этом
 * можно было только случайно. Ручка проявляется при наведении и меняет курсор
 * на «схватить» — этого хватает, чтобы догадаться, и это не шумит в списке,
 * пока мышь не рядом.
 *
 * Держим отдельным компонентом: четыре списка выглядят по-разному, и без
 * общего куска подсказка в каждом получилась бы своя.
 *
 * Тянуть при этом можно всю карточку, а не только ручку, — она подсказка,
 * а не единственная точка захвата.
 */
export function DragHandle({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      title={t('common.dragToChat')}
      aria-hidden
      className={cn(
        'shrink-0 cursor-grab text-muted-foreground/50 opacity-0 transition-opacity active:cursor-grabbing group-hover:opacity-100',
        className,
      )}
    >
      <GripVertical className="size-4" />
    </span>
  )
}
