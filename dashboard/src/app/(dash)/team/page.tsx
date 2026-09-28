'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Select, Spinner, Table } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuth';
import { useApi } from '@/hooks/useApi';
import { CATEGORY_LABEL, formatDateTime, formatMoney, formatRelative } from '@/lib/format';
import type { AdminUser, CategoryRule, Project, Task } from '@/lib/types';

type Tab = 'users' | 'projects' | 'categories' | 'audit';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'users', label: 'Kullanicilar' },
  { id: 'projects', label: 'Projeler & Gorevler' },
  { id: 'categories', label: 'Kategori Kurallari' },
  { id: 'audit', label: 'Denetim Kaydi' },
];

export default function TeamPage() {
  const { user } = useAuthUser();
  const [tab, setTab] = useState<Tab>('users');
  const isAdmin = user?.role === 'admin';

  return (
    <>
      <Card title="Yonetim" subtitle="Kullanici, proje, uretkenlik kurali ve denetim kayitlari">
        <div className="flex flex-wrap gap-1">
          {TABS.filter((item) => item.id !== 'users' || isAdmin || user?.role === 'manager').map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                tab === item.id ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </Card>

      {tab === 'users' && <UsersTab isAdmin={isAdmin} />}
      {tab === 'projects' && <ProjectsTab />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'audit' && <AuditTab />}
    </>
  );
}

// ------------------------------------------------------------------- users
function UsersTab({ isAdmin }: { isAdmin: boolean }) {
  const users = useApi(() => api.admin.users({ limit: 200 }), []);
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'employee',
    department: '',
    hourlyRate: '0',
  });
  const [message, setMessage] = useState<string | null>(null);
  const [agentKey, setAgentKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.admin.createUser({
        name: form.name,
        email: form.email,
        password: form.password,
        role: form.role,
        department: form.department || null,
        hourlyRate: Number(form.hourlyRate) || 0,
      });
      setMessage(`${form.email} olusturuldu.`);
      setForm({ name: '', email: '', password: '', role: 'employee', department: '', hourlyRate: '0' });
      users.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Kullanici olusturulamadi');
    } finally {
      setBusy(false);
    }
  };

  const updateUser = async (target: AdminUser, patch: Record<string, unknown>) => {
    try {
      await api.admin.updateUser(target.id, patch);
      users.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Guncelleme basarisiz');
    }
  };

  const createAgentKey = async () => {
    try {
      const response = await api.auth.createAgentKey();
      setAgentKey(response.apiKey);
      users.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'API anahtari uretilemedi');
    }
  };

  return (
    <>
      {agentKey && (
        <Card title="Agent API anahtari" subtitle="Bu anahtar bir daha gosterilmeyecek">
          <code className="block break-all rounded-lg bg-slate-900 px-3 py-2 text-xs text-emerald-300">
            {agentKey}
          </code>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setAgentKey(null)}>
            Kapattim, gizle
          </Button>
        </Card>
      )}

      {isAdmin && (
        <Card title="Yeni kullanici" subtitle="Saatlik ucret bordro hesabinda kullanilir">
          <form onSubmit={createUser} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Ad soyad">
              <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="E-posta">
              <Input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Gecici parola" hint="En az 8 karakter">
              <Input
                type="password"
                required
                minLength={8}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
            <Field label="Rol">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="employee">Calisan</option>
                <option value="manager">Takim lideri</option>
                <option value="admin">Yonetici</option>
              </Select>
            </Field>
            <Field label="Departman">
              <Input
                value={form.department}
                placeholder="Yazilim"
                onChange={(e) => setForm({ ...form, department: e.target.value })}
              />
            </Field>
            <Field label="Saatlik ucret">
              <Input
                type="number"
                min={0}
                step="0.01"
                value={form.hourlyRate}
                onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
              />
            </Field>
            <div className="sm:col-span-2 lg:col-span-3">
              <Button type="submit" disabled={busy}>
                {busy ? 'Kaydediliyor...' : 'Kullanici olustur'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Ekip" subtitle="Agent API anahtarini bu ekrandan uretebilirsiniz">
        {message && (
          <div className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</div>
        )}
        {users.error && <ErrorBanner message={users.error} onRetry={users.refresh} />}
        {!users.loaded && <Spinner />}
        {users.loaded && (users.data?.items ?? []).length === 0 && <EmptyState title="Kullanici yok" />}

        {(users.data?.items ?? []).length > 0 && (
          <Table head={['Kullanici', 'Rol', 'Departman', 'Saatlik', 'Agent anahtari', 'Son gorulme', 'Islem']}>
            {(users.data?.items ?? []).map((row) => (
              <tr key={row.id} className="hover:bg-slate-50/70">
                <td className="td">
                  <div className="font-medium text-slate-800">{row.name}</div>
                  <div className="text-xs text-slate-500">{row.email}</div>
                </td>
                <td className="td">
                  <Select
                    value={row.role}
                    disabled={!isAdmin}
                    onChange={(event) => updateUser(row, { role: event.target.value })}
                    className="w-36"
                  >
                    <option value="employee">Calisan</option>
                    <option value="manager">Takim lideri</option>
                    <option value="admin">Yonetici</option>
                  </Select>
                </td>
                <td className="td text-slate-600">{row.department ?? '-'}</td>
                <td className="td">
                  <span className="text-slate-700">{formatMoney(row.hourlyRate, row.currency)}</span>
                </td>
                <td className="td">
                  {row.hasAgentKey ? <Badge tone="green">Tanimli</Badge> : <Badge>Yok</Badge>}
                </td>
                <td className="td text-slate-500">{formatRelative(row.lastSeenAt)}</td>
                <td className="td">
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={createAgentKey}>
                      Anahtar uret
                    </Button>
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => updateUser(row, { isActive: !row.isActive })}
                        title={row.isActive ? 'Pasife al' : 'Aktiflestir'}
                      >
                        {row.isActive ? 'Pasife al' : 'Aktiflestir'}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- projects
function ProjectsTab() {
  const projects = useApi(() => api.admin.projects(), []);
  const [selected, setSelected] = useState<string>('');
  const tasks = useApi(() => api.admin.tasks(selected || undefined), [selected]);
  const [projectName, setProjectName] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const response = await api.admin.createProject({ name: projectName });
      setProjectName('');
      setSelected(response.project.id);
      projects.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Proje olusturulamadi');
    }
  };

  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    try {
      await api.admin.createTask({ projectId: selected, title: taskTitle });
      setTaskTitle('');
      tasks.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Gorev olusturulamadi');
    }
  };

  const list: Project[] = projects.data?.items ?? [];

  return (
    <>
      {message && <ErrorBanner message={message} />}

      <Card title="Proje olustur">
        <form onSubmit={createProject} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <Field label="Proje adi">
              <Input required value={projectName} onChange={(e) => setProjectName(e.target.value)} />
            </Field>
          </div>
          <Button type="submit">Ekle</Button>
        </form>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Projeler" subtitle="Gorevleri gormek icin secin">
          {!projects.loaded && <Spinner />}
          {projects.loaded && list.length === 0 && <EmptyState title="Proje yok" />}
          <ul className="space-y-2">
            {list.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => setSelected(project.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                    selected === project.id
                      ? 'border-brand-300 bg-brand-50'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <span className="block text-sm font-medium text-slate-800">{project.name}</span>
                  <span className="block text-xs text-slate-500">
                    {project.description ?? 'Aciklama yok'} {project.isArchived ? '· arsivli' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Gorevler" subtitle={selected ? 'Secili projenin gorevleri' : 'Once proje secin'}>
          {selected && (
            <form onSubmit={createTask} className="mb-4 flex flex-wrap items-end gap-3">
              <div className="min-w-[12rem] flex-1">
                <Field label="Gorev basligi">
                  <Input required value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
                </Field>
              </div>
              <Button type="submit" variant="secondary">
                Gorev ekle
              </Button>
            </form>
          )}

          {!tasks.loaded && <Spinner />}
          {tasks.loaded && (tasks.data?.items ?? []).length === 0 && <EmptyState title="Gorev yok" />}

          {(tasks.data?.items ?? []).length > 0 && (
            <Table head={['Gorev', 'Durum', 'Faturalanabilir']}>
              {(tasks.data?.items ?? []).map((task: Task) => (
                <tr key={task.id}>
                  <td className="td font-medium text-slate-700">{task.title}</td>
                  <td className="td">
                    <Select
                      value={task.status}
                      className="w-36"
                      onChange={async (event) => {
                        await api.admin.updateTask(task.id, { status: event.target.value });
                        tasks.refresh();
                      }}
                    >
                      <option value="todo">Yapilacak</option>
                      <option value="in_progress">Devam ediyor</option>
                      <option value="blocked">Engellendi</option>
                      <option value="done">Tamamlandi</option>
                    </Select>
                  </td>
                  <td className="td">
                    {task.isBillable ? <Badge tone="green">Evet</Badge> : <Badge>Hayir</Badge>}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

// -------------------------------------------------------------- categories
function CategoriesTab() {
  const [matchType, setMatchType] = useState<'app' | 'domain'>('domain');
  const rules = useApi(() => api.admin.categories(), []);
  const [form, setForm] = useState({
    pattern: '',
    category: 'UNPRODUCTIVE' as CategoryRule['category'],
    department: '',
    priority: '50',
  });
  const [test, setTest] = useState({ app: '', url: '' });
  const [testResult, setTestResult] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.admin.createCategory({
        matchType,
        pattern: form.pattern,
        category: form.category,
        department: form.department || null,
        priority: Number(form.priority) || 50,
      });
      setForm({ ...form, pattern: '' });
      rules.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Kural eklenemedi');
    }
  };

  const runTest = async () => {
    if (!test.app && !test.url) {
      setTestResult('Uygulama veya URL girin.');
      return;
    }
    try {
      const response = await api.admin.testCategory({ app: test.app || undefined, url: test.url || undefined });
      setTestResult(CATEGORY_LABEL[response.category] ?? response.category);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'Test basarisiz');
    }
  };

  const items: CategoryRule[] = rules.data?.items ?? [];

  return (
    <>
      {message && <ErrorBanner message={message} />}

      <Card
        title="Yeni kategori kurali"
        subtitle="Uygulama ve domain etiketleri uretkenlik skorunu belirler (global veya departman bazli)"
      >
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Tip">
            <Select value={matchType} onChange={(e) => setMatchType(e.target.value as 'app' | 'domain')}>
              <option value="domain">Domain</option>
              <option value="app">Uygulama</option>
            </Select>
          </Field>
          <Field label="Desen" hint="Ornek: youtube.com veya *.atlassian.net">
            <Input required value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
          </Field>
          <Field label="Kategori">
            <Select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as CategoryRule['category'] })}
            >
              <option value="PRODUCTIVE">Uretken</option>
              <option value="UNPRODUCTIVE">Uretken degil</option>
              <option value="NEUTRAL">Notr</option>
            </Select>
          </Field>
          <Field label="Departman" hint="Bos = global kural">
            <Input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
          </Field>
          <Field label="Oncelik" hint="Kucuk deger = yuksek oncelik">
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                max={1000}
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              />
              <Button type="submit">Ekle</Button>
            </div>
          </Field>
        </form>
      </Card>

      <Card title="Kural testi" subtitle="Belirli bir uygulama/URL hangi kategoriye girer?">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Uygulama">
            <Input
              value={test.app}
              placeholder="chrome.exe"
              onChange={(e) => setTest({ ...test, app: e.target.value })}
            />
          </Field>
          <Field label="URL">
            <Input
              value={test.url}
              placeholder="https://youtube.com/watch?v=1"
              onChange={(e) => setTest({ ...test, url: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button variant="secondary" onClick={runTest}>
              Test et
            </Button>
          </div>
        </div>
        {testResult && <p className="mt-3 text-sm text-slate-700">Sonuc: {testResult}</p>}
      </Card>

      <Card title="Kurallar" subtitle={`${items.length} kayit`}>
        {rules.error && <ErrorBanner message={rules.error} onRetry={rules.refresh} />}
        {!rules.loaded && <Spinner />}
        {rules.loaded && items.length === 0 && <EmptyState title="Kural yok" />}

        {items.length > 0 && (
          <Table head={['Tip', 'Desen', 'Kategori', 'Kapsam', 'Oncelik', 'Durum', '']}>
            {items.map((rule) => (
              <tr key={rule.id} className="hover:bg-slate-50/70">
                <td className="td">
                  <Badge tone="brand">{rule.matchType === 'app' ? 'Uygulama' : 'Domain'}</Badge>
                </td>
                <td className="td font-medium text-slate-700">{rule.pattern}</td>
                <td className="td">
                  <Badge
                    tone={
                      rule.category === 'PRODUCTIVE' ? 'green' : rule.category === 'UNPRODUCTIVE' ? 'rose' : 'slate'
                    }
                  >
                    {CATEGORY_LABEL[rule.category]}
                  </Badge>
                </td>
                <td className="td text-slate-600">{rule.department ?? 'Global'}</td>
                <td className="td text-slate-600">{rule.priority}</td>
                <td className="td">
                  {rule.isActive ? <Badge tone="green">Aktif</Badge> : <Badge>Pasif</Badge>}
                </td>
                <td className="td">
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await api.admin.updateCategory(rule.id, { isActive: !rule.isActive });
                        rules.refresh();
                      }}
                    >
                      {rule.isActive ? 'Pasife al' : 'Aktiflestir'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        if (!window.confirm(`${rule.pattern} kurali silinsin mi?`)) return;
                        await api.admin.deleteCategory(rule.id);
                        rules.refresh();
                      }}
                    >
                      Sil
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

// ------------------------------------------------------------------- audit
function AuditTab() {
  const audit = useApi(() => api.admin.audit({ limit: 100 }), []);

  return (
    <Card title="Denetim kaydi" subtitle="Silme, onay ve yonetim islemleri">
      {audit.error && <ErrorBanner message={audit.error} onRetry={audit.refresh} />}
      {!audit.loaded && <Spinner />}
      {audit.loaded && (audit.data?.items ?? []).length === 0 && <EmptyState title="Kayit yok" />}

      {(audit.data?.items ?? []).length > 0 && (
        <Table head={['Zaman', 'Islem', 'Varlik', 'Detay']}>
          {(audit.data?.items ?? []).map((entry, index) => (
            <tr key={index} className="hover:bg-slate-50/70">
              <td className="td text-slate-600">{formatDateTime(String(entry.createdAt))}</td>
              <td className="td font-medium text-slate-700">{String(entry.action)}</td>
              <td className="td text-slate-600">
                {String(entry.entityType)}
                {entry.entityId ? ` · ${String(entry.entityId).slice(0, 8)}` : ''}
              </td>
              <td className="td max-w-[28rem] truncate text-xs text-slate-500">
                {JSON.stringify(entry.metadata ?? {})}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
