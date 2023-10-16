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

        .greenway-route-line {
            display: inline-block;
            width: 10px;
            margin:5px 0;
            height:2px;
            background:
              repeating-linear-gradient(90deg,red 0 5px,#0000 0 7px)
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
                <ul>
                    <li>
                        <i class="greenway-route-line"></i>
                        <input
                            type="checkbox"
                            id="greenway-routes"
                            name="greenway-routes"
                            checked
                        >
                        <label for="routes">Greenway Routes</label>
                    </li>
                    <li>
                        <input
                            type="checkbox"
                            id="signed-routes"
                            name="signed-routes"
                            checked
                        >
                        <label for="routes">Signed Routes</label>
                    </li>
                    <li>
                        <input
                            type="checkbox"
                            id="suggested-routes"
                            name="suggested-routes"
                            checked
                        >
                        <label for="routes">Suggested Routes</label>
                    </li>
                </ul>

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