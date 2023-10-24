import { css } from "lit";

export const baseStyles = css`
    :host {
        font-family: 'Open Sans', sans-serif;
    }

    .card {
        background: #fff;
        padding: 1rem;
        border-radius: 4px;
    }

    h2.card {

    }

    .height-1 {
        box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);
    }

    .height-2 {
        box-shadow: 0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23);
    }

    button.nostyle {
        --mdc-icon-size: 2rem;
        border: none;
        background: unset;
        padding: 0;
    }
`;