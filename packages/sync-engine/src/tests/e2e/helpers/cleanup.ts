/**
 * Resource tracking and cleanup for integration tests
 * Tracks Stripe resources created during tests and cleans them up
 */
import Stripe from 'stripe'

export class ResourceTracker {
  private customerIds: string[] = []
  private productIds: string[] = []
  private priceIds: string[] = []
  private planIds: string[] = []
  private webhookIds: string[] = []

  trackCustomer(id: string): void {
    this.customerIds.push(id)
  }

  trackProduct(id: string): void {
    this.productIds.push(id)
  }

  trackPrice(id: string): void {
    this.priceIds.push(id)
  }

  trackPlan(id: string): void {
    this.planIds.push(id)
  }

  trackWebhook(id: string): void {
    this.webhookIds.push(id)
  }

  async cleanup(stripe: Stripe): Promise<void> {
    // Delete in reverse dependency order: prices -> products -> customers

    for (const id of this.priceIds) {
      try {
        // Prices can't be deleted, only deactivated
        await stripe.prices.update(id, { active: false })
      } catch {
        // Ignore errors
      }
    }

    for (const id of this.planIds) {
      try {
        await stripe.plans.del(id)
      } catch {
        // Ignore errors
      }
    }

    for (const id of this.productIds) {
      try {
        await stripe.products.del(id)
      } catch {
        // Try to archive if delete fails
        try {
          await stripe.products.update(id, { active: false })
        } catch {
          // Ignore
        }
      }
    }

    for (const id of this.customerIds) {
      try {
        await stripe.customers.del(id)
      } catch {
        // Ignore errors
      }
    }

    for (const id of this.webhookIds) {
      try {
        await stripe.webhookEndpoints.del(id)
      } catch {
        // Ignore errors
      }
    }

    // Clear tracking arrays
    this.customerIds = []
    this.productIds = []
    this.priceIds = []
    this.planIds = []
    this.webhookIds = []
  }
}
