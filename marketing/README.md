# Skyworker Marketing Website

A modern, conversion-optimized marketing landing page for cf-opencode (Skyworker).

## Overview

This marketing site showcases cf-opencode's key value propositions:
- Run Claude agents 24/7 in isolated Cloudflare workspaces
- Close your laptop and keep building
- Share workspaces with your team
- Deploy from anywhere, on any device

## Design

The site follows modern SaaS landing page best practices:
- Clear hero section with strong value proposition: "Close your laptop. Keep building."
- Feature cards highlighting key benefits
- Use case scenarios showing real-world applications
- Social proof with testimonials
- Strong call-to-action throughout
- Clean, professional design inspired by Amp and modern product sites
- Fully responsive mobile design

## Tech Stack

- Pure HTML/CSS - no build step required
- Modern CSS with CSS variables for easy theming
- Responsive design for all devices
- Optimized for fast loading

## Deployment

### Cloudflare Pages

1. Connect this repository to Cloudflare Pages
2. Set build settings:
   - Build command: (none)
   - Build output directory: marketing
   - Root directory: marketing

### Local Preview

Simply open `index.html` in your browser. No server required.

Or use the cf-opencode preview:
```bash
cd marketing
skyworker-preview 8000
python3 -m http.server 8000
```

## Customization

The design uses CSS variables for easy theming. Edit the `:root` section in the `<style>` tag:

```css
:root {
    --primary: #2563eb;
    --primary-dark: #1e40af;
    --accent: #0ea5e9;
    /* ... more variables */
}
```

## Structure

- **Hero Section**: Main value proposition and CTA
- **Features**: Six key benefits with icons
- **Use Cases**: Four detailed scenarios showing cf-opencode in action
- **Social Proof**: Customer testimonials
- **Final CTA**: Strong conversion section
- **Footer**: Navigation and links

## Performance

- No external dependencies
- Single HTML file
- Optimized CSS with minimal animations
- Fast load times on Cloudflare's edge network
