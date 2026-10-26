import { render } from 'preact'
import { App } from './app/App'
import { openFromLocation } from './app/controller'
import './styles.css'

render(<App />, document.getElementById('app')!)
void openFromLocation()
