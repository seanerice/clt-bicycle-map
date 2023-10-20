import { LitElement, html, css } from 'lit';
import { googleIconStyles } from './google-fonts.css.js';

export class MwcIcon extends LitElement {
    static get properties() {
        return {
            icon: { type: String },
        };
    }
    
    static styles = [
        googleIconStyles,
        css`
            :host {
                display: flex;
            }
        `
    ];

    render() {
        return html`
            <span class="material-symbols-outlined">
                ${this.icon}
            </span>
        `;
    }
}
customElements.define('mwc-icon', MwcIcon);
