# Typeroll

Typeroll is an open-source website and application platform.

The open-source edition is being prepared for publication in this repository. The source will be added after the boundary between the community edition and Typeroll Cloud has been completed and reviewed.

This repository is not ready for production use yet.

## Extensions

Developers can start building integrations with the [Typeroll Extension starter](https://github.com/Typeroll/extension-starter).

Typeroll uses three explicit runtime boundaries:

- **Core modules** such as Forms are included with the CMS: in Typeroll Cloud for hosted customers and in the operator's environment for self-hosted installations. Forms does not require a Typeroll App or Extension purchase.
- **Typeroll Apps** are optional premium products operated only in Typeroll-controlled cloud accounts. Self-hosting the CMS never deploys a Typeroll App backend into the operator's infrastructure.
- **Third-party Extensions** integrate provider-owned SaaS or bespoke systems. Their backends and data remain in the developer's own accounts, and published components call those APIs directly. Typeroll and customer hosting accounts do not act as reverse proxies.

Customer sites remain static. A custom calculator, quiz or lead interface may submit directly to the site's ordinary Forms module without requiring a separate application backend.

See the public [Extension architecture](https://docs.typeroll.com/extensions/overview/) and [self-hosting guide](https://docs.typeroll.com/guides/self-hosting/) for the protocol and deployment model.

## Documentation

Public documentation is available at [docs.typeroll.com](https://docs.typeroll.com/).

## License

Typeroll is released under the [MIT License](LICENSE).
