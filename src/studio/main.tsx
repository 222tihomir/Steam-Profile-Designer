import { createRoot } from 'react-dom/client'
import App from '../editor/App'
import { Boundary } from '../editor/Boundary'
import '../editor/styles.css'

document.documentElement.classList.add('spd-studio')

const container = document.getElementById('root')
if (!container) throw new Error('Не найден контейнер #root')

createRoot(container).render(
  <Boundary>
    <App surface="studio" />
  </Boundary>,
)
