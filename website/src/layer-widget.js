import { ContextConsumer } from "@lit/context";
import { LitElement, html, css, nothing } from "lit";
import { mapContext } from "./mapContext";
import './ser-checkbox.js';
import { baseStyles } from "./styles";

export class LayerWidget extends LitElement {
    _mapConsumer = new ContextConsumer(
        this,
        {
            context: mapContext,
            subscribe: true
        }
    );

    connectedCallback() {
        super.connectedCallback();
        this.addEventListener('updated', this._handleUpdated)
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        super.addEventListener('updated', this._handleUpdated);
    }

    static get properties() {
        return {};
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

    _toggleLayer = (layerId, visible) => {
        if (visible)
            this._mapConsumer.value.setLayoutProperty(layerId, 'visibility', 'visible');
        else
            this._mapConsumer.value.setLayoutProperty(layerId, 'visibility', 'none');
    };

    _handleUpdated(event) {
        const { checked, indeterminate, id: elementId } = event.detail;

        const setRouteFilters = () => {
            const greenwayRoutesElement = this.shadowRoot.getElementById('greenway-routes');
            const signedRoutesElement = this.shadowRoot.getElementById('signed-routes');
            const suggestedRoutesElement = this.shadowRoot.getElementById('suggested-routes');
            const routeFilters = this._calculateRouteFilters({
                greenwayRoutes: greenwayRoutesElement.checked,
                signedRoutes: signedRoutesElement.checked,
                suggestedRoutes: suggestedRoutesElement.checked
            })
            this._mapConsumer.value.setFilter('cycling-route-lines', routeFilters);
            this._mapConsumer.value.setFilter('cycling-route-symbols', routeFilters);
        }

        const setCyclePathFilters = () => {
            const allowedCyclePathsElement = this.shadowRoot.getElementById('allowed-cycle-paths');
            const designatedCyclePathsElement = this.shadowRoot.getElementById('designated-cycle-paths');
            const cyclePathFilters = this._calculatePathFilters({
                allowed: allowedCyclePathsElement.checked,
                designated: designatedCyclePathsElement.checked
            });
            this._mapConsumer.value.setFilter('cycling-paths', cyclePathFilters);
        }

        switch (elementId) {
            case 'routes':
                this._toggleLayer('cycling-route-lines', checked || indeterminate);
                this._toggleLayer('cycling-route-symbols', checked || indeterminate);
                setRouteFilters();
                break;
            case 'greenway-routes':
            case 'signed-routes':
            case 'suggested-routes':
                setRouteFilters();
                break;
            case 'bike-lanes':
                this._toggleLayer('cycling-lanes-right', checked || indeterminate);
                this._toggleLayer('cycling-lanes-left', checked || indeterminate);
                break;
            case 'cycle-paths':
                this._toggleLayer('cycling-paths', checked || indeterminate);
                setCyclePathFilters();
                break;
            case 'allowed-cycle-paths':
            case 'designated-cycle-paths':
                setCyclePathFilters();
                break;
            default:
                break;
        }
    }

    static styles = [
        baseStyles,
        css`
            :host {
                font-family: 'Open Sans', sans-serif;
                display: block;
                position: absolute;
                right: 10px;
                top: 10px;
                z-index: 1;
            }

            .widget {
                max-width: 33.3vw;
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
        `
    ];

    render() {
        if (!this._mapConsumer.value) {
            return nothing;
        }

        return html`
            <div class="card height-1 widget">
                <ser-checkbox id="routes" label="Routes" .checked=${true}>
                    <ser-checkbox id="greenway-routes" .checked=${true}>
                        <label slot="label"><span class="greenway-route-line"></span>Greenway Routes</label>
                    </ser-checkbox>
                    <ser-checkbox id="signed-routes" .checked=${true}>
                        <label slot="label"><span class="signed-route-line"></span>Signed Routes</label>
                    </ser-checkbox>
                    <ser-checkbox id="suggested-routes" .checked=${true}>
                        <label slot="label"><span class="suggested-route-line"></span>Suggested Routes</label>
                    </ser-checkbox>
                </ser-checkbox>
                <ser-checkbox id="bike-lanes" label="Bike Lanes" .checked=${true}></ser-checkbox>
                <ser-checkbox id="cycle-paths" label="Cycle Paths" .checked=${true}>
                    <ser-checkbox id="allowed-cycle-paths" .checked=${true}>
                        <label slot="label"><span class="allowed-path-line"></span>Allowed</label>
                    </ser-checkbox>
                    <ser-checkbox id="designated-cycle-paths" .checked=${true}>
                        <label slot="label"><span class="designated-path-line"></span>Designated</label>
                    </ser-checkbox>
                </ser-checkbox>
            </div>
        `;
    }
}

customElements.define('layer-widget', LayerWidget);