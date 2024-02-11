import { LitElement, html, css, nothing } from 'lit';
import { ContextConsumer } from '@lit/context';
import { classMap } from 'lit-html/directives/class-map.js';
import { baseStyles } from './styles';
import { mapContext } from './mapContext';
import mapboxgl from 'mapbox-gl';

export class LocationSearchMenu extends LitElement {
    _mapConsumer = new ContextConsumer(
        this,
        {
            context: mapContext,
            subscribe: true,
            callback: (v) => this._mapChanged(v)
        }
    );

    get _map() {
        return this._mapConsumer.value;
    }

    static get properties() {
        return {
            _searchResults: { type: Array },
            _locationSearchTerm: { type: String },
            _showChooseLocationWidget: { type: Boolean },
        };
    }

    show() {
        this.shadowRoot.getElementById('location-search-input').focus();
        this._showChooseLocationWidget = true;
    }

    hide() {
        this._showChooseLocationWidget = false;
    }

    resetFields() {
        this._searchResults = null;
        this._locationSearchTerm = '';
    }

    async _handleLocationSearchButton() {
        await this.searchForLocation();
    }

    async _handleLocationSearchKeyDown(event) {
        if (event.keyCode === 13) {
            await this.searchForLocation();
        }
    }

    async searchForLocation() {
        const locationSearchInput = this.shadowRoot.getElementById('location-search-input');
        const search = locationSearchInput.value;
        this._locationSearchTerm = search;
        const data = await this.geocodingSearch(search);
        this._searchResults = data.features;
    }

    _setCoord(coord, displayText) {
        this.dispatchEvent(
            new CustomEvent('location-selected', {
                detail: {
                    coord,
                    displayText
                },
                bubbles: true
            }));
    }

    _menuClickHandler(menuItemType, options) {
        return (event) => {
            this._placePointMode = false;
            let coord;
            switch (menuItemType) {
                case 'my-location':
                    navigator.geolocation.getCurrentPosition(
                        (pos) => {
                            coord = [
                                pos.coords.longitude,
                                pos.coords.latitude
                            ];
                            this.geocodingSearch(...coord).then(res => {
                                const displayText = res.features[0].place_name;
                                this._setCoord(coord, displayText);
                            });
                        },
                        (err) => {
                            console.error(err);
                        }
                    );
                    this.hide();
                    this.resetFields();
                    break;
                case 'select-location-on-map':
                    this._placePointMode = true;
                    this.hide();
                    this.resetFields();
                    break;
                case 'searched-location':
                    this._setCoord(options.searchResult.center, options.searchResult.place_name);
                    this.hide();
                    this.resetFields();
                default:
                    break;
            }
        };
    }

    async geocodingSearch(...args) {
        if (args.length === 0 || args.length > 2) {
            throw new Error("args array may only have length of 1 or 2.");
        }

        let geocodingApiUrl;

        if (args.length === 1) {
            geocodingApiUrl = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(args[0])}.json`);
        }

        if (args.length === 2 && args.every(arg => Number(arg))) {
            geocodingApiUrl = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${args.map(arg => Number(arg)).join(',')}.json`);
        }

        geocodingApiUrl.searchParams.set('access_token', mapboxgl.accessToken);
        geocodingApiUrl.searchParams.set('types', 'place,neighborhood,address,poi');
        geocodingApiUrl.searchParams.set('bbox', '-81.06355,35.00332,-80.52998,35.41154');
        const res = await fetch(
            geocodingApiUrl,
            { method: 'get' }
        );
        const data = await res.json();
        return data;
    }

    _mapChanged(map) {
        if (!map)
            return;

        map.on('click', (event) => {
            if (this._placePointMode) {
                const coord = Object.keys(event.lngLat)
                    .map((key) => event.lngLat[key]);

                this.geocodingSearch(...coord).then(res => {
                    const displayText = res.features[0].place_name;
                    this._setCoord(coord, displayText);
                });
                this._placePointMode = false;
            }
        });
    }

    static styles = [
        baseStyles,
        css`
            :host {
                display: block;
            }

            #choose-location-widget {
                position: fixed;
                height: 100vh;
                height: 100dvh;
                bottom: -100vh;
                bottom: -100dvh;
                left: 0;
                right: 0;
                background-color: white;
                z-index: 300;
                transition: all 0.5s ease;
                display: flex;
                flex-direction: column;
                align-items: stretch;
            }

            #choose-location-widget.visible {
                bottom: 0;
            }

            .search-bar {
                z-index: 100;
                height: 3rem;
                left: 60px;
                right: 10rem;
                top: 10px;
                position: fixed;
                transition: all 0.5s ease, z-index 0.1s ease;
            }

            .search-bar input {
                background-color: white;
                border-radius: 1rem;
                height: 100%;
                width: 100%;
                box-sizing: border-box;
                position: relative;
                padding-left: 1rem;
                padding-right: 3rem;
                outline: 0;
                text-overflow: ellipsis;
            }

            .search-bar button {
                height: 100%;
                right: 2rem;
                position: absolute;
                top: 0;
            }

            .search-bar.show-in-menu {
                z-index: 301;
                left: 0;
                right: 0;
                padding: 1rem;
                top: 2rem;
            }

            .menu-item {
                display: block;
                padding: 1rem;
                cursor: pointer;
            }

            .menu-item > * {
                display: inline-block;
                vertical-align: middle;
            }

            .menu-item > mwc-icon {
                margin-right: 1rem;                
            }

            .menu-item:hover {
                background-color: lightgray;
            }

            .menu-padding {
                height: 5rem;
            }

            .close-button {
                align-self: flex-start;
                cursor: pointer;
            }
        `
    ];

    _searchResultsTemplate() {
        if (!this._searchResults) {
            return nothing;
        }

        if (this._searchResults.length <= 0) {
            return html`
                <p class="menu-item">No Results</p>`;
        }

        return this._searchResults.map(searchResult => {
            return html`
                <a class="menu-item" @click=${this._menuClickHandler('searched-location', { searchResult })}>
                    <mwc-icon icon="location_on"></mwc-icon>
                    ${searchResult.text}
                    ${searchResult.place_name}
                </a>
            `;
        });
    }

    render() {
        return html`
            <div class="search-bar ${classMap({ 'show-in-menu': this._showChooseLocationWidget })}">
                <input
                    id="location-search-input"
                    type="text"
                    placeholder="Search..."
                    .value=${this._locationSearchTerm || ''}
                    @keydown=${this._handleLocationSearchKeyDown}
                    @focus=${() => { this.show() }}>
                <button class="nostyle" @click=${this._handleLocationSearchButton}>
                    <mwc-icon icon="search"></mwc-icon>
                </button>
            </div>
            <div id="choose-location-widget" class=${classMap({ visible: this._showChooseLocationWidget })}>
                <button
                    id="close-nav-button"
                    class="nostyle close-button"
                    @click=${() => { this.hide(); }}
                >
                    <mwc-icon icon="close"></mwc-icon>
                </button>
                <div class="menu-padding"></div>
                ${this._searchResultsTemplate()}
                ${this._searchResults ? html`<hr>` : nothing}
                <a class="menu-item" @click=${this._menuClickHandler('my-location')}>
                    <mwc-icon icon="my_location"></mwc-icon>
                    My Location
                </a>
                <a class="menu-item" @click=${this._menuClickHandler('select-location-on-map')}>
                    <mwc-icon icon="location_on"></mwc-icon>
                    Choose on the Map
                </a>
            </div>
        `;
    }
}
customElements.define('location-search-menu', LocationSearchMenu);
