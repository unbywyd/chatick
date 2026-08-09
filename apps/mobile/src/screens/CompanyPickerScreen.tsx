import { useState } from 'react'
import {
  ActivityIndicator,
  I18nManager,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CompaniesResponse, type Company, type CompanyInvite } from '../lib/api'
import { LogoMark } from '../components/Logo'
import { Avatar } from '../components/Avatar'
import { Txt } from '../components/Txt'
import { LanguagePicker } from '../components/LanguagePicker'
import { IconChevronRight, IconLogOut, IconPlus } from '../components/icons'
import { theme } from '../theme'

// Выбор компании — обязательный шаг после входа (SPEC §4.3).
//
// Токен действует на всю компанию: пока она не выбрана, непонятно, чьи
// проекты показывать.

export function CompanyPickerScreen({
  onPick,
  onLogout,
}: {
  onPick: (company: Company) => void
  onLogout: () => void
}) {
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const q = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompaniesResponse>('/api/v1/companies'),
  })

  const create = useMutation({
    mutationFn: (n: string) =>
      api<Company>('/api/v1/companies', { method: 'POST', body: JSON.stringify({ name: n }) }),
    onSuccess: async (company) => {
      await qc.invalidateQueries({ queryKey: ['companies'] })
      onPick(company)
    },
  })

  const accept = useMutation({
    mutationFn: (token: string) =>
      api<unknown>(`/api/v1/companies/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  })

  if (q.isPending) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={theme.brand} />
      </View>
    )
  }

  if (q.isError) {
    return (
      <View style={s.center}>
        <Txt style={s.error}>{t('mobile.companiesFailed')}</Txt>
        <Pressable style={s.retry} onPress={() => void q.refetch()}>
          <Txt style={s.retryText}>{t('mobile.retry')}</Txt>
        </Pressable>
      </View>
    )
  }

  const companies = q.data?.companies ?? []
  const invites = q.data?.invites ?? []
  // Своя — одна. Считаем по isOwner, а не по роли: админом делают и в чужой.
  const hasOwn = companies.some((c) => c.isOwner)

  // Совсем пусто — человек здесь впервые. Показываем сразу поле ввода: другого
  // пути отсюда всё равно нет.
  const firstRun = companies.length === 0 && invites.length === 0
  const showForm = creating || firstRun

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 32 }]}
    >
      <View style={s.head}>
        <LogoMark size={30} />
        <View style={s.headRight}>
          <LanguagePicker compact />
          <Pressable
            style={s.logoutBtn}
            onPress={onLogout}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('start.logout')}
          >
            <IconLogOut size={15} color={theme.muted} />
            <Txt style={s.logout}>{t('start.logout')}</Txt>
          </Pressable>
        </View>
      </View>

      <Txt style={s.title}>{firstRun ? t('start.companyTitle') : t('mobile.pickCompany')}</Txt>
      <Txt style={s.sub}>{firstRun ? t('start.companySubtitle') : t('mobile.pickCompanyHint')}</Txt>

      {invites.length > 0 ? (
        <View style={s.section}>
          <Txt style={s.sectionTitle}>{t('start.invitesTitle')}</Txt>
          {invites.map((i: CompanyInvite) => (
            <View key={i.id} style={s.inviteRow}>
              <Avatar name={i.company.name} logoUrl={i.company.logoUrl} />
              <View style={s.rowText}>
                {/* Название компании — чужой текст: направление отдаём
                    платформе, иначе ивритское имя развернётся в английском
                    интерфейсе (Rule 3). */}
                <Txt auto style={s.rowName} numberOfLines={1}>
                  {i.company.name}
                </Txt>
                <Txt style={s.rowMeta}>{i.role}</Txt>
              </View>
              <Pressable style={s.acceptBtn} disabled={accept.isPending} onPress={() => accept.mutate(i.token)}>
                <Txt style={s.acceptText}>{accept.isPending ? '…' : t('start.accept')}</Txt>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {companies.length > 0 ? (
        <View style={s.section}>
          {invites.length > 0 ? <Txt style={s.sectionTitle}>{t('start.yourCompanies')}</Txt> : null}
          {companies.map((c) => (
            <Pressable key={c.id} style={s.row} onPress={() => onPick(c)}>
              <Avatar name={c.name} logoUrl={c.logoUrl} />
              <View style={s.rowText}>
                <Txt auto style={s.rowName} numberOfLines={1}>
                  {c.name}
                </Txt>
                <Txt style={s.rowMeta}>
                  {(c.isOwner ? t('mobile.ownCompany') : c.myRole) +
                    ' · ' +
                    (c.projectsCount === 0
                      ? t('mobile.noProjects')
                      : t('mobile.projectsCount', { count: c.projectsCount }))}
                </Txt>
              </View>
              <IconChevronRight size={18} color={theme.muted} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {showForm ? (
        <View style={s.form}>
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            placeholder={t('start.companyName')}
            placeholderTextColor={theme.muted}
            autoFocus={!firstRun}
            maxLength={120}
            returnKeyType="done"
            onSubmitEditing={() => name.trim() && create.mutate(name.trim())}
          />
          {create.isError ? (
            <Txt style={s.error}>
              {/* Сервер отвечает 409, если своя компания уже есть. Показываем
                  причину, а не «что-то пошло не так». */}
              {(create.error as Error).message.includes('already have')
                ? t('mobile.alreadyHaveCompany')
                : t('mobile.createFailed')}
            </Txt>
          ) : null}
          <Pressable
            style={[s.primary, !name.trim() && s.primaryOff]}
            disabled={!name.trim() || create.isPending}
            onPress={() => create.mutate(name.trim())}
          >
            {create.isPending ? <ActivityIndicator color={theme.brandFg} /> : null}
            <Txt style={s.primaryText}>{t('start.create')}</Txt>
          </Pressable>
          {!firstRun ? (
            <Pressable onPress={() => setCreating(false)} hitSlop={12}>
              <Txt style={s.cancel}>{t('common.cancel')}</Txt>
            </Pressable>
          ) : null}
        </View>
      ) : !hasOwn ? (
        // Кнопки нет, когда своя компания уже есть: обещать действие, которое
        // сервер отклонит с 409, — худший вид неработающей кнопки.
        <Pressable style={s.ghost} onPress={() => setCreating(true)}>
          <IconPlus size={17} color={theme.fg} />
          <Txt style={s.ghostText}>{t('mobile.createOwnCompany')}</Txt>
        </Pressable>
      ) : null}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { paddingHorizontal: 20, gap: 8 },
  center: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', gap: 16 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  logout: { color: theme.muted, fontSize: 14 },
  title: { color: theme.fg, fontSize: 28, fontWeight: '700' },
  sub: { color: theme.muted, fontSize: 15, lineHeight: 21, marginBottom: 12 },
  section: { gap: 8, marginTop: 12 },
  sectionTitle: { color: theme.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.card,
    borderRadius: theme.radius,
    padding: 14,
  },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.cardSoft,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
  },
  rowText: { flex: 1, gap: 2 },
  rowName: { color: theme.fg, fontSize: 16, fontWeight: '600' },
  rowMeta: { color: theme.muted, fontSize: 13 },
  acceptBtn: { backgroundColor: theme.brand, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9 },
  acceptText: { color: theme.brandFg, fontSize: 14, fontWeight: '700' },
  form: { gap: 12, marginTop: 20, alignItems: 'stretch' },
  input: {
    backgroundColor: theme.card,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.fg,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    // Выравнивание в поле ввода НЕ следует за раскладкой само (Rule 3):
    // без этого в иврите курсор прижимается влево, а текст утекает от него.
    textAlign: I18nManager.isRTL ? 'right' : 'left',
  },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: theme.brand,
    borderRadius: 999,
    paddingVertical: 16,
  },
  primaryOff: { opacity: 0.4 },
  primaryText: { color: theme.brandFg, fontSize: 16, fontWeight: '700' },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingVertical: 15,
    marginTop: 20,
  },
  ghostText: { color: theme.fg, fontSize: 15, fontWeight: '600' },
  cancel: { color: theme.muted, fontSize: 14, textAlign: 'center' },
  error: { color: theme.danger, fontSize: 14, textAlign: 'center' },
  retry: { borderWidth: 1, borderColor: theme.border, borderRadius: 999, paddingHorizontal: 22, paddingVertical: 11 },
  retryText: { color: theme.fg, fontSize: 15, fontWeight: '600' },
})
