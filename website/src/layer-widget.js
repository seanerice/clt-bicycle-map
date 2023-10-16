import { ContextConsumer } from "@lit/context";
import { LitElement, html, css } from "lit";
import { mapContext } from "./mapContext";

export class LayerWidget extends LitElement {
    _mapConsumer = new ContextConsumer(
        this,
        {
            context: mapContext,
            subscribe: true
        });
    
    _routeFilters = this._calculateRouteFilters();

    constructor() {
        super();

        // Filters state
        this.greenwayRoutesEnabled = true;
        this.signedRoutesEnabled = true;
        this.suggestedRoutesEnabled = true;
        this.allowedPathsEnabled = true;
        this.designatedPathsEnabled = true;
    }
 
    static get properties() {
        return {
            greenwayRoutesEnabled: { type: Boolean },
            signedRoutesEnabled: { type: Boolean },
            suggestedRoutesEnabled: { type: Boolean },
            allowedPathsEnabled: { type: Boolean },
            designatedPathsEnabled: { type: Boolean }
        };
    }

    _calculateRouteFilters(options = {}) {
        const { greenwayRoutes, signedRoutes, suggestedRoutes } = options;

        const filters = [
            'all',
            ['==', ['get', 'route'], 'bicycle'],
            ['!=', ['get', 'state'], 'proposed']
        ];

        if (greenwayRoutes === false) {
            filters.push(['!=', ['get', 'cycle_network'], 'US:NC:Mecklenburg']);
        }

        if (signedRoutes === false) {
            filters.push([
                '!',
                [
                    'all',
                    ['==', ['get', 'cycle_network'], 'US:NC:Charlotte'],
                    ['has', 'ref']
                ]
            ]);
        }

        if (suggestedRoutes === false) {
            filters.push(['!=', ['get', 'cycle_network'], 'US:NC:Charlotte:Suggested Bike Route']);
        }

        return filters;
    }

    _calculatePathFilters(options = {}) {
        const { allowed, designated } = options;

        const filters = [
            'all',
            ['has', 'bicycle'],
            ['==', ['get', 'highwayType'], 'path']
        ];

        if (allowed === false) {
            filters.push(['!=', ['get', 'bicycle'], 'yes']);
        }

        if (designated === false) {
            filters.push(['!=', ['get', 'bicycle'], 'designated']);
        }

        return filters;
    }

    static styles = css`
        :host {
            display: block;
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
            margin: 5px 0;
            height: 5px;
            background:
              repeating-linear-gradient(90deg, #3964C4 0 5px)
        }

        .signed-route-line {
            display: inline-block;
            width: 10px;
            margin: 5px 0;
            height: 5px;
            background:
              repeating-linear-gradient(90deg, #e6c627 0 5px)
        }

        .suggested-route-line {
            display: inline-block;
            width: 10px;
            margin: 5px 0;
            height: 5px;
            background:
              repeating-linear-gradient(90deg, #8539C4 0 5px)
        }

        .allowed-path-line {
            display: inline-block;
            width: 10px;
            margin: 5px 0;
            height: 2px;
            background:
              repeating-linear-gradient(90deg, #0DDD37 0 5px)
        }

        .designated-path-line {
            display: inline-block;
            width: 10px;
            margin: 5px 0;
            height: 2px;
            background:
              repeating-linear-gradient(90deg, #2747c4 0 5px)
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
                        <span class="greenway-route-line"></span>
                        <input
                            type="checkbox"
                            id="greenway-routes"
                            name="greenway-routes"
                            .checked=${this.greenwayRoutesEnabled}
                        >
                        <label for="routes">Greenway Routes</label>
                    </li>
                    <li>
                        <span class="signed-route-line"></span>
                        <input
                            type="checkbox"
                            id="signed-routes"
                            name="signed-routes"
                            .checked=${this.signedRoutesEnabled}
                        >
                        <label for="routes">Signed Routes</label>
                    </li>
                    <li>
                        <span class="suggested-route-line"></span>
                        <input
                            type="checkbox"
                            id="suggested-routes"
                            name="suggested-routes"
                            .checked=${this.suggestedRoutesEnabled}
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
                <ul>
                    <li>
                        <span class="allowed-path-line"></span>
                        <input
                            type="checkbox"
                            id="allowed-paths"
                            name="allowed-paths"
                            .checked=${this.allowedPathsEnabled}
                        >
                        <label for="routes">Allowed Cycle Paths</label>
                    </li>
                    <li>
                        <span class="designated-path-line"></span>
                        <input
                            type="checkbox"
                            id="designated-paths"
                            name="designated-paths"
                            .checked=${this.designatedPathsEnabled}
                        >
                        <label for="routes">Designated Cycle Paths</label>
                    </li>
                </ul>
            </div>
        `;
    }

    _toggleLayer = (layerId, visible) => {
        if (visible)
            this._mapConsumer.value.setLayoutProperty(layerId, 'visibility', 'visible');
        else
            this._mapConsumer.value.setLayoutProperty(layerId, 'visibility', 'none');
    };

    _calculateToggleInputState(input, childInputs) {

    }

    _handleClick(event) {
        const elementId = event.target.id;
        const checked = event.target.checked;

        switch(elementId) {
            case 'routes':
                this._toggleLayer('cycling-route-lines', event.target.checked);
                this._toggleLayer('cycling-route-symbols', event.target.checked);
                this.greenwayRoutesEnabled = checked;
                this.signedRoutesEnabled = checked;
                this.suggestedRoutesEnabled = checked;
                break;
            case 'greenway-routes':
                this.greenwayRoutesEnabled = checked;
                break;
            case 'signed-routes':
                this.signedRoutesEnabled = checked;
                break;
            case 'suggested-routes':
                this.suggestedRoutesEnabled = checked;
                break;
            case 'cycle-lanes':
                this._toggleLayer('cycling-lanes-right', event.target.checked);
                this._toggleLayer('cycling-lanes-left', event.target.checked);
                break;
            case 'cycle-paths':
                this._toggleLayer('cycling-paths', event.target.checked);
                this.allowedPathsEnabled = checked;
                this.designatedPathsEnabled = checked;
                break;
            case 'allowed-paths':
                this.allowedPathsEnabled = checked;
                break;
            case 'designated-paths':
                this.designatedPathsEnabled = checked;
                break;
            default:
                break;
        }

        this._routeFilters = this._calculateRouteFilters({
            greenwayRoutes: this.greenwayRoutesEnabled,
            signedRoutes: this.signedRoutesEnabled,
            suggestedRoutes: this.suggestedRoutesEnabled
        });
        this._cyclePaths = this._calculatePathFilters({
            allowed: this.allowedPathsEnabled,
            designated: this.designatedPathsEnabled
        });
        this._mapConsumer.value.setFilter('cycling-route-lines', this._routeFilters);
        this._mapConsumer.value.setFilter('cycling-route-symbols', this._routeFilters);
        this._mapConsumer.value.setFilter('cycling-paths', this._cyclePaths);
    }
}

customElements.define('layer-widget', LayerWidget);