import { ContextConsumer } from "@lit/context";
import { LitElement, html, css } from "lit";
import { mapContext } from "./mapContext";

export class LayerWidget extends LitElement {
    _mapConsumer = new ContextConsumer(
        this,
        {
            context: mapContext,
            subscribe: true,
            callback: (v) => console.log("works" + v)
        });
 
    static get properties() {
        return {};
    }

    static styles = css`
        :host {
            //display: block;
        }

        #menu {
            position: absolute;
            background: #efefef;
            padding: 10px;
            font-family: 'Open Sans', sans-serif;
            z-index: 1;
        }
    `;

    render() {
        return html`
            <div
                id='menu'
                @click="${this._handleClick}">
                <input
                    type="checkbox"
                    id="routes"
                    name="routes"
                    checked
                >
                <label for="routes">Routes</label><br>
                <input
                    type="checkbox"
                    id="cycle-lanes"
                    name="cycle-lanes"
                    checked
                >
                <label for="routes">Cycle Lanes</label><br>
                <input
                    type="checkbox"
                    id="cycle-paths"
                    name="cycle-paths"
                    checked
                >
                <label for="routes">Cycle Paths</label><br>
            </div>
        `;
    }

    _toggleLayer = (layerId, visible) => {
        if (visible)
            this._mapConsumer.value.setLayoutProperty(layerId, 'visibility', 'visible');
        else
            this._mapConsumer.value.setLayoutProperty(layerId, 'visibility', 'none');
    };

    _handleClick(event) {
        const elementId = event.target.id;
        switch(elementId) {
            case 'routes':
                this._toggleLayer('cycling-route-lines', event.target.checked);
                this._toggleLayer('cycling-route-symbols', event.target.checked);
                break;
            case 'cycle-lanes':
                this._toggleLayer('cycling-lanes-right', event.target.checked);
                this._toggleLayer('cycling-lanes-left', event.target.checked);
                break;
            case 'cycle-paths':
                this._toggleLayer('cycling-paths', event.target.checked);
                break;
            default:
                break;
        }
    }
}

customElements.define('layer-widget', LayerWidget);