import { useTranslation } from 'react-i18next'
import { errorCode, useHandoff, type HandoffAction } from '../data'
import { useUi } from '../ui'

type Ballish = {
  id: string
  number: string
  status: string
  project: { id: string } | null
  holder: { id: string } | null
  owner: { id: string } | null
  ball: { move: string; waitingClientSince: string | null }
}

/**
 * Что можно сделать с мячом из строки, панели или меню — одно место на все.
 *
 * Ходы с запиской открывают окно передачи; ходы без записки (принять,
 * забрать, клиент ответил) уходят сразу. Окончательное слово — за сервером:
 * если он откажет, человек увидит почему.
 */
export function useBallActions(task: Ballish, myId: string | undefined) {
  const { t } = useTranslation('v2')
  const { openHo, flash } = useUi()
  const handoff = useHandoff()
  const open = task.status !== 'done' && task.status !== 'cancelled'
  const mine = Boolean(myId) && task.holder?.id === myId
  const owner = Boolean(myId) && task.owner?.id === myId
  const client = Boolean(task.ball.waitingClientSince)
  const plain = open && mine && !client

  const direct = (action: HandoffAction, done: string) => {
    if (!task.project) return
    handoff.mutate(
      { taskId: task.id, projectId: task.project.id, action, to: action === 'take' ? myId : undefined },
      {
        onSuccess: () => flash(done),
        onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
      },
    )
  }
  const ho = (action: HandoffAction | 'other') => () => openHo({ taskId: task.id, action })

  return {
    open,
    mine,
    isRev: plain && task.ball.move === 'review',
    isDo: plain && task.ball.move === 'do',
    isAns: plain && task.ball.move === 'answer',
    isClient: open && mine && client,
    isAway: open && !mine,
    canTake: open && !mine && owner,
    canAsk: open && mine,
    canClient: open && mine,
    canPassOn: plain && task.ball.move !== 'do',
    accept: () => direct('accept', t('ho.done.accept', { id: task.number })),
    take: () => direct('take', t('ho.done.take')),
    clientReplied: () => direct('client_replied', t('ho.done.client_replied')),
    waitClient: () => direct('wait_client', t('ho.done.wait_client')),
    toggleClient: () => (client ? direct('client_replied', t('ho.done.client_replied')) : direct('wait_client', t('ho.done.wait_client'))),
    back: ho('return'),
    toReview: ho('review'),
    pass: ho('other'),
    answer: ho('answer'),
    ask: ho('ask'),
    cancel: ho('cancel'),
    reopen: ho('reopen'),
    pending: handoff.isPending,
  }
}
