import { LitElement, html, css, nothing } from 'lit';

export class SerCheckbox extends LitElement {
    static get properties() {
        return {
            label: { type: String }
        };
    }

    get _checkbox() {
        return this.shadowRoot.getElementById('checkbox');
    }

    get checked() {
        return this._checkbox.checked;
    }

    set checked(value) {
        this._checkbox.checked = value;
        this._propagateDownwards(value);
        this._dispatchUpdatedEvent({ checked: this.checked, intederminate: this.indeterminate });
    }

    get indeterminate() {
        return this._checkbox.indeterminate;
    }

    set indeterminate(value) {
        this._checkbox.indeterminate = value;
    }

    get _slottedChildren() {
        const slot = this.shadowRoot.querySelector('slot');
        return slot.assignedElements({ flatten: true });
    }

    get _slottedCheckboxes() {
        return this._slottedChildren.filter(child => child.matches('ser-checkbox'));
    }

    _updateState() {
        const allChildrenChecked = this._slottedCheckboxes.every((input) => input.checked);
        const anyChildrenChecked = this._slottedCheckboxes.some((input) => input.checked);
        const anyChildrenIndeterminate = this._slottedCheckboxes.some((input) => input.indeterminate);
        const inputElement = this.shadowRoot.getElementById('checkbox');
        if (allChildrenChecked) {
            inputElement.checked = true;
            inputElement.indeterminate = false;
        } else if (anyChildrenChecked || anyChildrenIndeterminate) {
            inputElement.checked = false;
            inputElement.indeterminate = true;
        } else {
            inputElement.checked = false;
            inputElement.indeterminate = false;
        }
        this._dispatchUpdatedEvent({ checked: inputElement.checked, indeterminate: inputElement.indeterminate });
        this._dispatchInternalUpdatedEvent({ checked: inputElement.checked, indeterminate: inputElement.indeterminate });
    }

    _dispatchInternalUpdatedEvent(options) {
        const { checked, indeterminate } = options;
        this.dispatchEvent(new CustomEvent('internal-updated', {
            detail: { checked: checked, indeterminate: indeterminate },
            bubbles: true,
            composed: true 
        }));
    }

    _dispatchUpdatedEvent(options) {
        const { checked, indeterminate } = options;
        this.dispatchEvent(new CustomEvent('updated', {
            detail: { id: this.getAttribute('id'), checked: checked, indeterminate: indeterminate },
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

        this._propagateDownwards(checked);

        this._dispatchInternalUpdatedEvent({
            checked: checked,
            indeterminate: indeterminate
        });
        this._dispatchUpdatedEvent({
            checked: checked,
            indeterminate: indeterminate
        });
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
        if (!label)
            return nothing;

        return html`
            <label for="checkbox">${label}</label>
        `;
    }

    render() {
        return html`
            <input
                id="checkbox"
                type="checkbox"
                name="checkbox"
                @click=${this._handleClick}>
            ${this._renderLabel(this.label)}
            <slot @internal-updated=${this._handleInternalUpdated}></slot>
        `;
    }
}
customElements.define('ser-checkbox', SerCheckbox);
