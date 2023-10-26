import { ContextConsumer } from "@lit/context";
import { LitElement, html, css, nothing, unsafeCSS } from "lit";
import { mapContext } from "./mapContext";
import './ser-checkbox.js';
import { baseStyles } from "./styles";
import { bicycleFacilityRatingColor, roadwayPalette, routePalette } from "./colors";

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

    _calculateLaneFilters(options = {}) {
        const {
            cycletracks,
            bufferedLanes,
            standardLanes,
            shareBuswayLanes,
            shoulderLanes
        } = options;

        const cyclewayRightFilters = [
            'all',
            ['has', 'cyclewayRight'],
            ['!=', ['get', 'cyclewayRight'], 'no']
        ];
        const cyclewayLeftFilters = [
            'all',
            ['has', 'cyclewayLeft'],
            ['!=', ['get', 'cyclewayLeft'], 'no']
        ]

        if (cycletracks === false) {
            cyclewayRightFilters.push(['!=', ['get', 'cyclewayRight'], 'track']);
            cyclewayLeftFilters.push(['!=', ['get', 'cyclewayLeft'], 'track']);
        }

        if (bufferedLanes === false) {
            cyclewayRightFilters.push([
                '!',
                [
                    'all',
                    ['==', ['get', 'cyclewayRight'], 'lane'],
                    ['has', 'cyclewayRightBuffer'],
                ]
            ]);
            cyclewayLeftFilters.push([
                '!',
                [
                    'all',
                    ['==', ['get', 'cyclewayLeft'], 'lane'],
                    ['has', 'cyclewayLeftBuffer'],
                ]
            ]);
        }

        if (standardLanes === false) {
            cyclewayRightFilters.push(['!=', ['get', 'cyclewayRight'], 'lane']);
            cyclewayLeftFilters.push(['!=', ['get', 'cyclewayLeft'], 'lane']);
        }

        if (shareBuswayLanes === false) {
            cyclewayRightFilters.push(['!=', ['get', 'cyclewayRight'], 'share_busway']);
            cyclewayLeftFilters.push(['!=', ['get', 'cyclewayLeft'], 'share_busway']);
        }

        if (shoulderLanes === false) {
            cyclewayRightFilters.push(['!=', ['get', 'cyclewayRight'], 'shoulder']);
            cyclewayLeftFilters.push(['!=', ['get', 'cyclewayLeft'], 'shoulder']);
        }

        return [cyclewayLeftFilters, cyclewayRightFilters];
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
            });
            this._mapConsumer.value.setFilter('cycling-route-lines', routeFilters);
            this._mapConsumer.value.setFilter('cycling-route-symbols', routeFilters);
        }

        const setLaneFilters = () => {
            const cycletrackElement = this.shadowRoot.getElementById('cycletrack-lanes');
            const bufferedLaneElement = this.shadowRoot.getElementById('buffered-lanes');
            const standardLaneElement = this.shadowRoot.getElementById('standard-lanes');
            const shareBuswayLaneElement = this.shadowRoot.getElementById('share-busway-lanes');
            const shoulderLaneElement = this.shadowRoot.getElementById('shoulder-lanes');

            const [cyclewayLeftFilters, cyclewayRightFilters] = this._calculateLaneFilters({
                cycletracks: cycletrackElement.checked,
                bufferedLanes: bufferedLaneElement.checked,
                standardLanes: standardLaneElement.checked,
                shareBuswayLanes: shareBuswayLaneElement.checked,
                shoulderLanes: shoulderLaneElement.checked
            });
            this._mapConsumer.value.setFilter('cycling-lanes-right', cyclewayRightFilters);
            this._mapConsumer.value.setFilter('cycling-lanes-left', cyclewayLeftFilters);
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
                setLaneFilters();
                break;
            case 'cycletrack-lanes':
            case 'buffered-lanes':
            case 'standard-lanes':
            case 'share-busway-lanes':
            case 'shoulder-lanes':
                setLaneFilters();
                break
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
                display: block;
            }

            .greenway-route-line {
                background:
                    repeating-linear-gradient(90deg, ${unsafeCSS(routePalette.greenway)} 0 5px)
            }

            .signed-route-line {
                background:
                    repeating-linear-gradient(90deg, ${unsafeCSS(routePalette.signed)} 0 5px)
            }

            .suggested-route-line {
                background:
                    repeating-linear-gradient(90deg, ${unsafeCSS(routePalette.suggested)} 0 5px)
            }

            .cycletrack-line {
                background:
                    repeating-linear-gradient(90deg, ${unsafeCSS(roadwayPalette.cycleTrack)} 0 3px, transparent 0 5px)
            }

            .buffered-lane-line {
                background:
                    repeating-linear-gradient(90deg, ${unsafeCSS(roadwayPalette.bufferedLane)} 0 3px, transparent 0 5px)
            }

            .lane-line {
                background:
                    repeating-linear-gradient(90deg, ${unsafeCSS(roadwayPalette.lane)} 0 3px, transparent 0 5px)
            }

            .share-busway-line {
                background:
                    repeating-linear-gradient(90deg, ${unsafeCSS(roadwayPalette.shareBusway)} 0 3px, transparent 0 5px)
            }

            .shoulder-line {
                background:
                    repeating-linear-gradient(90deg, ${unsafeCSS(roadwayPalette.shoulder)} 0 3px, transparent 0 5px)
            }

            .allowed-path-line {
                background:
                    repeating-linear-gradient(90deg, ${unsafeCSS(bicycleFacilityRatingColor.good)} 0 5px)
            }

            .designated-path-line {
                background:
                    repeating-linear-gradient(90deg,  ${unsafeCSS(bicycleFacilityRatingColor.excellent)} 0 5px)
            }

            .legend.path {
                display: inline-block;
                margin: 5px;
                width: 12px;
                height: 2px;
            }

            .legend.route {
                display: inline-block;
                margin: 5px;
                width: 12px;
                height: 5px;
            }

            ser-checkbox > ser-checkbox {
                margin-left: 1rem;
            }
        `
    ];

    render() {
        if (!this._mapConsumer.value) {
            return nothing;
        }

        return html`
            <div>
                <h3>Layers</h3>
                <ser-checkbox id="routes" label="Routes" .checked=${true}>
                    <ser-checkbox id="greenway-routes" label="Greenway Routes" .checked=${true}>
                        <span slot="pre-label" class="legend route greenway-route-line"></span>
                    </ser-checkbox>
                    <ser-checkbox id="signed-routes" label="Signed Routes" .checked=${true}>
                        <span slot="pre-label" class="legend route signed-route-line"></span>
                    </ser-checkbox>
                    <ser-checkbox id="suggested-routes" label="Suggested Routes" .checked=${true}>
                        <span slot="pre-label" class="legend route suggested-route-line"></span>
                    </ser-checkbox>
                </ser-checkbox>
                <ser-checkbox id="bike-lanes" label="Bike Lanes" .checked=${true}>
                    <ser-checkbox id="cycletrack-lanes" label="Cycle Track" .checked=${true}>
                        <span slot="pre-label" class="legend path cycletrack-line"></span>
                    </ser-checkbox>
                    <ser-checkbox id="buffered-lanes" label="Buffered Lane" .checked=${true}>
                        <span slot="pre-label" class="legend path buffered-lane-line"></span>
                    </ser-checkbox>
                    <ser-checkbox id="standard-lanes" label="Standard Bike Lane" .checked=${true}>
                        <span slot="pre-label" class="legend path lane-line"></span>
                    </ser-checkbox>
                    <ser-checkbox id="share-busway-lanes" label="Shared Bus & Bike Lane" .checked=${true}>
                        <span slot="pre-label" class="legend path share-busway-line"></span>
                    </ser-checkbox>
                    <ser-checkbox id="shoulder-lanes" label="Shoulder" .checked=${true}>
                        <span slot="pre-label" class="legend path shoulder-line"></span>
                    </ser-checkbox>
                </ser-checkbox>
                <ser-checkbox id="cycle-paths" label="Cycle Paths" .checked=${true}>
                    <ser-checkbox id="allowed-cycle-paths" label="Allowed" .checked=${true}>
                        <span slot="pre-label" class="legend path allowed-path-line"></span>
                    </ser-checkbox>
                    <ser-checkbox id="designated-cycle-paths" label="Designated" .checked=${true}>
                        <span slot="pre-label" class="legend path designated-path-line"></span>
                    </ser-checkbox>
                </ser-checkbox>
            </div>
        `;
    }
}

customElements.define('layer-widget', LayerWidget);