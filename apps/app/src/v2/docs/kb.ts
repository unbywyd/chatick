import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { inProject, SOCKET_EVENT, type SocketMessage } from '../data'

/**
 * Данные раздела «Документы и заметки».
 *
 * Документы живут в проекте: список — по всей компании одной ручкой
 * (/api/v1/company-documents), а сам документ, правка и версии — через
 * проект (X-Project). Заметки — в компании (/api/v1/company/:id/notes).
 */

export type Author = { id: string; name: string; avatarUrl?: string | null } | null

export type DocRow = { id: string; title: string; preview: string; publicSlug: string | null; updatedAt: string; author: Author }
export type DocFull = { id: string; title: string; content: string; publicSlug: string | null; updatedAt: string; createdAt: string; author: Author }
export type DocVersion = { id: string; version: number; title: string; note: string; createdAt: string; size: number; author: Author }

export type NoteRow = {
  id: string
  projectId: string | null
  type: string
  title: string
  body: string
  tags: string[]
  taskId: string | null
  author: Author
  project: { id: string; name: string } | null
  createdAt: string
  updatedAt: string
  matchedByMeaning?: boolean
}

export const kbKeys = {
  docs: (companyId: string) => ['v2', 'kb', 'docs', companyId] as const,
  doc: (docId: string) => ['v2', 'kb', 'doc', docId] as const,
  versions: (docId: string) => ['v2', 'kb', 'versions', docId] as const,
  notes: (companyId: string, q: string) => ['v2', 'kb', 'notes', companyId, q] as const,
}

export type DocItem = DocRow & { projectId: string }

/**
 * Документы всех видимых проектов компании — одним запросом (сервер сам
 * проверяет documents.read в каждом проекте).
 */
export function useAllDocs(companyId: string) {
  const q = useQuery({
    queryKey: kbKeys.docs(companyId),
    queryFn: () => api<{ items: DocItem[] }>(`/api/v1/company-documents/${companyId}`).then((r) => r.items),
    staleTime: 60_000,
  })
  return { items: q.data ?? EMPTY, loading: q.isLoading }
}
const EMPTY: DocItem[] = []

export function useDoc(projectId: string | null, docId: string | null) {
  return useQuery({
    queryKey: kbKeys.doc(docId ?? ''),
    queryFn: () => api<DocFull>(`/api/v1/documents/${docId}`, inProject(projectId!)),
    enabled: Boolean(projectId && docId),
    retry: false,
  })
}

export function useVersions(projectId: string, docId: string) {
  return useQuery({
    queryKey: kbKeys.versions(docId),
    queryFn: () => api<DocVersion[]>(`/api/v1/documents/${docId}/versions`, inProject(projectId)),
    staleTime: 30_000,
  })
}

/**
 * Заметки компании. q — поиск по смыслу на сервере: он стоит обращения к
 * модели, поэтому уходит по Enter, а не на каждую букву.
 */
export function useNotes(companyId: string, q: string) {
  return useQuery({
    queryKey: kbKeys.notes(companyId, q),
    queryFn: () =>
      api<{ items: NoteRow[] }>(
        `/api/v1/company/${companyId}/notes?` + new URLSearchParams({ limit: '200', ...(q ? { q } : {}) }),
      ).then((r) => r.items),
    staleTime: 30_000,
  })
}

/** Чужие правки приходят по сокету — перечитываем списки, а открытый документ сам себя не трогает. */
export function useKbSocket() {
  const qc = useQueryClient()
  useEffect(() => {
    const on = (e: Event) => {
      const { event } = (e as CustomEvent<SocketMessage>).detail
      if (event === 'documents_changed') void qc.invalidateQueries({ queryKey: ['v2', 'kb', 'docs'] })
      if (event === 'notes') void qc.invalidateQueries({ queryKey: ['v2', 'kb', 'notes'] })
    }
    window.addEventListener(SOCKET_EVENT, on)
    return () => window.removeEventListener(SOCKET_EVENT, on)
  }, [qc])
}

/** Текст из HTML — для поиска по заметкам на клиенте. */
export function htmlText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}
