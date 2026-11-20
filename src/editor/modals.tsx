import { useRef, useState } from 'react'
import type { Project, ProjectIndexEntry } from '../shared/types'
import { SHOWCASES } from '../shared/geometry'
import { Icon, Modal, formatDate, timeAgo } from './bits'

export function ProjectsModal({
  project,
  projects,
  onClose,
  onOpen,
  onNew,
  onDuplicate,
  onDelete,
  onRename,
  onImport,
  onExport,
  storage,
}: {
  project: Project
  projects: ProjectIndexEntry[]
  onClose: () => void
  onOpen: (id: string) => void
  onNew: () => void
  onDuplicate: () => void
  onDelete: (id: string) => void
  onRename: (name: string) => void
  onImport: (file: File) => void
  onExport: () => void
  storage: { usage: number; quota: number } | null
}) {
  const [name, setName] = useState(project.name)
  const fileRef = useRef<HTMLInputElement | null>(null)

  return (
    <Modal
      title={
        <span>
          Проекты <span className="spd-badge">{projects.length}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.spd.zip,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) onImport(file)
            }}
          />
          <button onClick={() => fileRef.current?.click()}>
            <Icon name="upload" /> Импорт проекта
          </button>
          <button onClick={onExport}>
            <Icon name="download" /> Экспорт проекта
          </button>
          <button className="primary" onClick={onNew}>
            <Icon name="plus" /> Новый проект
          </button>
        </>
      }
    >
      <div className="spd-card">
        <div className="spd-title">Текущий проект</div>
        <div className="spd-row">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => name.trim() && name !== project.name && onRename(name.trim())}
            placeholder="Название проекта"
          />
          <button
            onClick={() => {
              if (name.trim() && name !== project.name) onRename(name.trim())
            }}
          >
            <Icon name="save" /> Имя
          </button>
        </div>
        <div className="spd-row between">
          <span className="spd-hint">
            {SHOWCASES[project.target].title} · {project.export.format.toUpperCase()} {project.export.scale}×
          </span>
          <span className="spd-hint">обновлён {timeAgo(project.updatedAt)}</span>
        </div>
        <div className="spd-row">
          <button style={{ flex: 1 }} onClick={onDuplicate}>
            <Icon name="layers" /> Дублировать
          </button>
          <button style={{ flex: 1 }} onClick={onExport}>
            <Icon name="download" /> Скачать .spd.zip
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {projects.map((entry) => (
          <div key={entry.id} className={`spd-project-row ${entry.id === project.id ? 'current' : ''}`}>
            {entry.thumbnail ? <img src={entry.thumbnail} alt="" /> : <div style={{ width: 74, height: 44, borderRadius: 5, background: '#0d141b' }} />}
            <div className="info">
              <span className="nm">{entry.name}</span>
              <span className="sub">
                {SHOWCASES[entry.target]?.title ?? entry.target} · {timeAgo(entry.updatedAt)}
              </span>
              <span className="sub">{formatDate(entry.updatedAt)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <button className="ghost" onClick={() => onOpen(entry.id)} disabled={entry.id === project.id}>
                Открыть
              </button>
              <button className="ghost danger" onClick={() => onDelete(entry.id)} title="Удалить проект">
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}
        {!projects.length ? <div className="spd-hint">Проектов пока нет. Создайте первый.</div> : null}
      </div>

      {storage ? (
        <div className="spd-hint">
          Занято в браузере: {(storage.usage / 1024 / 1024).toFixed(1)} МБ
          {storage.quota ? ` из ${(storage.quota / 1024 / 1024 / 1024).toFixed(1)} ГБ` : ''}. Проекты и картинки
          хранятся только в IndexedDB вашего браузера.
        </div>
      ) : null}
    </Modal>
  )
}

export function HelpModal({ onClose, surface }: { onClose: () => void; surface: 'overlay' | 'studio' }) {
  return (
    <Modal title="Как это работает" onClose={onClose} size="normal">
      <div className="spd-card">
        <div className="spd-title">Главная идея</div>
        <p className="spd-hint" style={{ margin: 0 }}>
          Steam показывает фон профиля на всю страницу, а витрины — отдельными картинками в левой колонке.
          Редактор собирает одну композицию в координатах профиля (1920 px по ширине): фон, прозрачное окно,
          ваша картинка или GIF. На экспорт уходит ровно тот кусок, который встанет в витрину, поэтому он
          совпадает с профилем по месту и масштабу.
        </p>
      </div>
      <div className="spd-card">
        <div className="spd-title">Прозрачное окно</div>
        <p className="spd-hint" style={{ margin: 0 }}>
          Окно вырезает центр фона. В PNG и GIF прозрачность сохраняется: на странице Steam через неё виден
          настоящий фон профиля. Если ваша картинка с прозрачными краями, она «парит» над фоном, а не лежит
          прямоугольной плашкой. Окон может быть несколько.
        </p>
      </div>
      <div className="spd-card">
        <div className="spd-title">GIF</div>
        <ul className="spd-list">
          <li>Кадры и задержки исходного GIF сохраняются; анимация видна и в редакторе, и на странице. Если анимированных слоёв несколько, темп задаёт самый длинный, остальные берут кадр по времени.</li>
          <li>
            <b>Частота кадров.</b> «Как в фоне» оставляет ритм источника, пресеты пересобирают анимацию под
            выбранный fps. Под выбором показано, сколько кадров и какая длина цикла получится.
          </li>
          <li>
            <b>Кадры.</b> «Все кадры (плавно)» сохраняет полный ряд, «До 24 кадров (качество)» прореживает его,
            чтобы палитра осталась полной и детализация не пострадала.
          </li>
          <li>
            <b>Фон в GIF.</b> «960 px» сжимает видео-фон SPM по длинной стороне — файл легче; «Полный кадр (до
            1920 px)» берёт родное разрешение; «Только витрина (1:1)» обрезает кадры вокруг витрины, и фон не
            растягивается (за её пределами остаётся постер).
          </li>
          <li>
            <b>Дельта-кадры.</b> Пишутся только изменившиеся пиксели, а палитра — одна на всю анимацию: кадр 0
            объявляет её глобальной, остальные ссылаются на неё. Поэтому файл заметно легче, а вокруг движущихся
            объектов нет грязного контура из смешанных палитр.
          </li>
          <li>
            <b>Снижение палитры.</b> Когда файл больше 5 МБ, энкодер уменьшает число цветов шагами и
            пересобирает GIF. Без этой галочки файл останется как есть, а вы получите предупреждение о размере.
          </li>
          <li>GIF поддерживает только 1-битную прозрачность, поэтому полупрозрачные края становятся жёсткими.</li>
        </ul>
      </div>
      <div className="spd-card">
        <div className="spd-title">Скачивание</div>
        <ul className="spd-list">
          <li>ZIP содержит готовые файлы по витринам и <b>README.txt</b> — что и куда загружать, с текущими настройками экспорта.</li>
          <li>Без картинок ZIP всё равно собирается: внутри фон витрины и, если окно включено, <b>background_cutout.png</b>.</li>
          <li>Анимация (GIF-слой или видео-фон SPM) всегда экспортируется в GIF — PNG не подменяет её молча.</li>
          <li>Во время экспорта и разбора видео показывается процент и полоса: сначала подготовка кадров, затем кодирование.</li>
          <li>Всё считается в браузере: ни один файл не уходит на сервер.</li>
        </ul>
      </div>
      <div className="spd-card">
        <div className="spd-title">Предпросмотр и безопасность</div>
        <ul className="spd-list">
          <li>Предпросмотр только локальный: подменяется CSS-фон страницы и рисуется слой поверх витрины.</li>
          <li>Настоящий профиль, инвентарь и настройки Steam не изменяются.</li>
          <li>Ни один файл не отправляется на сервер: изображения читаются и кодируются в браузере.</li>
          <li>Кнопка «Сравнить» возвращает исходный вид, «Скрыть интерфейс» убирает панель.</li>
        </ul>
      </div>
      <div className="spd-card">
        <div className="spd-title">Совместимость со Steam Profile Modifier</div>
        <p className="spd-hint" style={{ margin: 0 }}>
          Оба расширения работают независимо. Мы не трогаем чужой DOM и читаем итоговый фон страницы, поэтому
          оформление, выбранное в Steam Profile Modifier, становится основой предпросмотра. Если то расширение
          поменяет фон во время нашей сессии, нажмите «Обновить разметку» — мы не боремся за стиль.
        </p>
      </div>
      <div className="spd-card">
        <div className="spd-title">Ограничения Steam, о которых честно</div>
        <ul className="spd-list">
          <li>Фон профиля — предмет инвентаря, его нельзя заменить произвольным PNG. Мы экспортируем витрину.</li>
          <li>Файл витрины — до 5 МБ. Помощник загрузки на странице иллюстрации подставляет витрину по имени файла, поля 1000×1 и патч GIF; после «Применить поля» рядом с кнопкой загорается «Применено».</li>
          <li>Анимированные фоны Steam используют отдельное видео; в композицию попадает статичный кадр.</li>
          <li>Порядок витрин задаётся в Steam; предпросмотр ставит композицию на место первой подходящей.</li>
        </ul>
      </div>
      <div className="spd-card">
        <div className="spd-title">{surface === 'studio' ? 'Предпросмотр на живом профиле' : 'Студия в отдельной вкладке'}</div>
        <p className="spd-hint" style={{ margin: 0 }}>
          {surface === 'studio'
            ? 'Откройте свой профиль на steamcommunity.com и нажмите кнопку расширения на панели браузера — панель редактора появится поверх страницы, а композиция встанет на место витрины. Проект подхватится автоматически.'
            : 'Панель поверх профиля — компактный режим. Если открыть этот же профиль и нажать кнопку расширения на панели браузера, откроется студия в отдельной вкладке: там большие полотна, все слои, сравнение и полный список настроек. Композиция общая с панелью.'}
        </p>
      </div>
      <div className="spd-card">
        <div className="spd-title">Горячие клавиши</div>
        <div className="spd-hint">
          <span className="spd-kbd">Esc</span> — закрыть окно · <span className="spd-kbd">колесо</span> — масштаб
          слоя · <span className="spd-kbd">перетаскивание</span> — положение ·{' '}
          <span className="spd-kbd">Shift</span> + стрелки — точное смещение (в полях).
        </div>
      </div>
      <div className="spd-card">
        <div className="spd-title">Лицензии и данные</div>
        <p className="spd-hint" style={{ margin: 0 }}>
          Геометрия витрин и приёмы GIF-кодирования сверены с MIT-проектом profile-editor
          (github.com/sweety1lime/profile-editor). Каталог фонов — выборка из его ежедневной выгрузки Steam
          Points Shop. Steam Profile Designer не связан с Valve.
        </p>
      </div>
    </Modal>
  )
}
