import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { keys } from '../data'
import { useUi } from '../ui'
import { HEROES, heroSrc } from '../heroes'
import { letterOf, personColor } from '../util'
import { useFail } from './parts'
import '../i18n/list'

/**
 * Герой за столом. Сервер выдал его случайно и по возможности без повторов;
 * здесь можно взять другого. Занятые коллегами — видно, у кого: брать их
 * можно, но лучше свободного — за одним столом два одинаковых героя путают.
 */
export function HeroPick() {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const q = useQuery({
    queryKey: ['v2', 'heroes'],
    queryFn: () => api<{ mine: string | null; taken: Record<string, { id: string; name: string }[]> }>('/api/v1/auth/me/heroes'),
  })
  const set = useMutation({
    mutationFn: (hero: string) => api('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ hero }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['v2', 'heroes'] })
      void qc.invalidateQueries({ queryKey: keys.me })
      void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
      flash(t('hero.saved'))
    },
    onError: fail,
  })
  const mine = set.isPending ? set.variables : q.data?.mine
  return (
    <section className="card sec">
      <h2>{t('hero.title')}</h2>
      <p className="d">{t('hero.sub')}</p>
      <div className="hero-pick" role="radiogroup" aria-label={t('hero.title')}>
        {HEROES.map((h) => {
          const who = q.data?.taken[h.slug] ?? []
          const on = mine === h.slug
          return (
            <button
              key={h.slug}
              role="radio"
              aria-checked={on}
              className={(on ? 'on' : '') + (who.length && !on ? ' taken' : '')}
              title={who.length ? t('hero.taken', { name: who.map((p) => p.name).join(', ') }) : undefined}
              onClick={() => !on && set.mutate(h.slug)}
            >
              <img src={heroSrc(h.slug)} alt="" loading="lazy" />
              {who.length > 0 && (
                <span className="who" style={{ background: personColor(who[0]!.id) }} aria-hidden="true">
                  {letterOf(who[0]!.name)}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
