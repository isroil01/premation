# Premation Cloud on Lemon Squeezy

Everything to paste into the product, field by field. It matches the landing
page (`motion-landing/src/lib/site.ts`) and the plan catalog
(`motion-back/src/billing/plans.ts`). Change those three together.

## Product

**Name**

```
Premation Cloud
```

**Short summary** (for any one-line field)

```
Ready-made motion, Premation's own plugins, and your projects on every computer. For the free Premation editor.
```

**Description**

```
Start from more than a blank comp.

Premation is a free, open-source motion design editor. Premation Cloud is the optional subscription for people who ship motion often: a shelf of ready-made work, our own plugins, and your projects on every computer you use.

What you get

The full Library
100+ premium templates, Lottie animations, transitions and sound effects. Every item drops into your project as ordinary layers and keyframes you can edit, not a flattened clip.

Premation plugins
Our own effects and tools, included as they ship, with nothing to buy one by one. They run on your computer.

Unlimited cloud projects
Open the same project on every computer you work on. The free plan keeps 5.

90 days of version history
Go back to last month's cut, not only last week's. The free plan keeps 7 days.

What stays free

The editor itself. Every tool, every effect and every export format, with no watermark. You pay for Cloud only if you want what it adds.

Free for 7 days

Try all of it for 7 days. The first payment is taken when the trial ends. Cancel before then and you pay nothing. One free trial per account.

If you cancel

You keep Cloud to the end of the period. After that your account moves to the free plan. Your projects are never deleted, and every one of them still opens and exports.

Yearly plans can be refunded in full within 14 days of payment, from Settings > Billing in the app.

Start from Settings > Billing in the Premation app. The app is a free download at premation.com/download.
```

## Variants

Both variants are subscriptions. Turn on **Subscription has free trial?** on both and set **7 days**.

| | Monthly | Yearly |
|---|---|---|
| Variant name | `Monthly` | `Yearly` |
| Price | $9.00 per month | $90.00 per year |
| Free trial | 7 days | 7 days |

**Monthly description**

```
$9 a month after your 7-day free trial. Cancel anytime.
```

**Yearly description**

```
$90 a year after your 7-day free trial. That is $7.50 a month, two months free. Cancel anytime.
```

The trial is one per account. The backend sends `skip_trial` for any account that
has subscribed before, so those checkouts charge straight away. That only covers
checkouts started from the app, so use the app as the way in: do not post the
product's public buy link anywhere.

## After checkout

**Confirmation title**

```
Your Premation Cloud trial has started
```

**Confirmation message**

```
You have 7 days of the full Library, Premation plugins and unlimited cloud projects. Nothing is charged until the trial ends. Head back to Premation and everything is ready.
```

**Button text**

```
Open Premation
```

Checkout already sends people back to the app (`LEMONSQUEEZY_REDIRECT_URL`, or
`APP_URL/#/dashboard?checkout=success`), so leave any button link to that.

**Receipt thank-you note**

```
Thank you for choosing Premation Cloud. Your subscription pays for the servers, the Library and the time that goes into every release of a free, open-source editor. Manage or cancel it anytime from Settings > Billing in the app.
```

## Image

| File | Use |
|---|---|
| `premation-cloud-1600x1200.png` | Main product image |
| `premation-cloud-1200x1200.png` | Anywhere that crops to a square |

Every tile is a real item: Library template posters and the Deep Glow cover. No
price is on the image, so a price change never makes it wrong. To change it,
edit `product-image.html` and run `render-image.sh` from this folder.

## Order of going live

The landing page and the editor promise a trial, so the trial has to exist
first.

1. Lemon Squeezy: paste the above and set the 7-day trial on **both** variants.
2. motion-back: deploy, with `PRO_TRIAL_DAYS=7` on Railway.
3. motion-landing: deploy (`CLOUD_TRIAL_DAYS = 7` is already set on the branch).
4. Editor: ships in the next release. Installed apps keep working; they show the
   old wording until they update.
