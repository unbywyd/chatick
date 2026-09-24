import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, Copy, ListPlus, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { API_URL } from '@/lib/api'

/**
 * Пустая доска задач.
 *
 * Раньше здесь было «Здесь пусто» — надпись, которая описывает состояние и
 * ничего не предлагает. Воронка обрывается ровно в этом месте: компанию
 * заводит половина зарегистрировавшихся, а до первой задачи доходят единицы.
 * На живых данных из 12 человек со стороны задачу создал ровно один.
 *
 * Способов два, и второй — главный. Создать руками умеет любой трекер;
 * подключить своего ИИ-ассистента — то, ради чего Chatick и сделан, и об этом
 * на пустом экране не было сказано ничего.
 *
 * Строку для ассистента даём КОПИРОВАТЬ, а не ссылкой: её вставляют в чужое
 * окно (Claude Code, ChatGPT), а не открывают в браузере. Ровно та же строка,
 * что на вкладке «Подключение», — источник один, расходиться нечему.
 */
export function TasksEmptyState({ canEdit, onCreate }: { canEdit: boolean; onCreate: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  // Та же строка, что в CompanyConnectTab: приглашение + адрес моста.
  // Ассистент читает по нему гайд и просит подтвердить доступ.
  const inviteLine = `${t('connect.pastePrefix')} ${API_URL.replace(/\/$/, '')}/x`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLine)
      setCopied(true)
      // Возврат к исходной надписи: иначе «Скопировано» висит навсегда и
      // непонятно, сработало ли нажатие во второй раз.
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Буфер недоступен (нет разрешения, http) — показываем саму строку,
      // чтобы её можно было выделить руками.
      toast.error(inviteLine)
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-dashed p-6 text-center sm:p-10">
      <h2 className="text-base font-semibold">{t('tasks.emptyTitle')}</h2>
      <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">{t('tasks.emptyLead')}</p>

      <div className="mx-auto mt-6 grid max-w-3xl gap-3 text-start sm:grid-cols-2">
        {/* Руками — первым: это понятно без объяснений и не требует ничего
            настраивать. Тому, кто пришёл просто завести задачу, не нужно
            читать про мост. */}
        <div className="flex flex-col rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2">
            <ListPlus className="size-4 shrink-0 text-brand-ink" />
            <h3 className="text-sm font-medium">{t('tasks.emptyManualTitle')}</h3>
          </div>
          <p className="mt-1 flex-1 text-xs text-muted-foreground">{t('tasks.emptyManualHint')}</p>
          {canEdit && (
            <Button variant="brand" size="sm" onClick={onCreate} className="mt-3 w-full">
              <Plus className="size-4" />
              {t('tasks.newTask')}
            </Button>
          )}
        </div>

        {/* Ассистент — ради него всё и затевалось, поэтому равноправной
            карточкой, а не сноской внизу мелким шрифтом. */}
        <div className="flex flex-col rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2">
            <Bot className="size-4 shrink-0 text-brand-ink" />
            <h3 className="text-sm font-medium">{t('tasks.emptyAiTitle')}</h3>
          </div>
          <p className="mt-1 flex-1 text-xs text-muted-foreground">{t('tasks.emptyAiHint')}</p>
          <Button variant="outline" size="sm" onClick={copy} className="mt-3 w-full">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? t('connect.copied') : t('tasks.emptyAiCopy')}
          </Button>
        </div>
      </div>
    </div>
  )
}
