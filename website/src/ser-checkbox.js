import { LitElement, html, css, nothing } from 'lit';

export class SerCheckbox extends LitElement {
    static get properties() {
        return {
            label: { type: String },
            checked: { type: Boolean },
            indeterminate: { type: Boolean }
        };
    }

    get _slottedChildren() {
        const slot = this.shadowRoot.getElementById('default-slot');
        return slot.assignedElements({ flatten: true });
    }

    get _slottedCheckboxes() {
        return this._slottedChildren.filter(child => child.matches('ser-checkbox'));
    }

    _updateState() {
        if (this._slottedCheckboxes.length > 0) {
            const allChildrenChecked = this._slottedCheckboxes.every((input) => input.checked);
            const anyChildrenChecked = this._slottedCheckboxes.some((input) => input.checked);
            const anyChildrenIndeterminate = this._slottedCheckboxes.some((input) => input.indeterminate);
            if (allChildrenChecked) {
                this.checked = true;
                this.indeterminate = false;
            } else if (anyChildrenChecked || anyChildrenIndeterminate) {
                this.checked = false;
                this.indeterminate = true;
            } else {
                this.checked = false;
                this.indeterminate = false;
            }
        }
        this._dispatchUpdatedEvent({ checked: this.checked, indeterminate: this.indeterminate });
        this._dispatchInternalUpdatedEvent({ checked: this.checked, indeterminate: this.indeterminate });
    }

    _dispatchInternalUpdatedEvent(detail) {
        this.dispatchEvent(new CustomEvent('internal-updated', {
            detail,
            bubbles: true,
            composed: true 
        }));
    }

    _dispatchUpdatedEvent(detail) {
        this.dispatchEvent(new CustomEvent('updated', {
            detail: { id: this.getAttribute('id'), ...detail },
            bubbles: true,
            composed: true 
        }));
    }

    _handleInternalUpdated(event) {
        event.stopPropagation();
        this._updateState();
    }

    _propagateDownwards(checked) {
        for (const child of this._slottedCheckboxes) {
            child.checked = checked;
            child.indeterminate = false;
        }
    }

    _handleClick(event) {
        event.stopPropagation();
        const checked = event.target.checked;
        const indeterminate = event.target.indeterminate;

        this.checked = checked;
        this.indeterminate = indeterminate;

        this._propagateDownwards(this.checked);
        this._dispatchInternalUpdatedEvent({
            checked,
            indeterminate
        });
        this._dispatchUpdatedEvent({ checked: this.checked, intederminate: this.indeterminate });
    }

    static styles = [
        css`
            :host {
                display: block;
                margin-left: 1rem;
            }
        `
    ];

    _renderLabel(label) {
        if (label) {
            return html`
                <label for="checkbox">
                    <slot
                        name="pre-label"
                        @slotchange=${this._handleLabelSlotChanged}
                    ></slot>
                    ${label}
                </label>
            `;
        }

        return nothing;
    }

    render() {
        return html`
            <input
                id="checkbox"
                type="checkbox"
                name="checkbox"
                .checked=${this.checked}
                .indeterminate=${this.indeterminate}
                @click=${this._handleClick}>
            ${this._renderLabel(this.label)}
            <slot
                id="default-slot"
                @slotchange=${this._handleSlotChange}
                @internal-updated=${this._handleInternalUpdated}
            ></slot>
        `;
    }
}
customElements.define('ser-checkbox', SerCheckbox);
