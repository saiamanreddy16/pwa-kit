/*
 * Copyright (c) 2025, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import React, {useEffect, useRef, useState, useCallback} from 'react'
import AdyenCheckout from '@adyen/adyen-web'
import '@adyen/adyen-web/dist/adyen.css'
import PropTypes from 'prop-types'
import {useAdyenExpressCheckout} from '@adyen/adyen-salesforce-pwa'
import {getCurrencyValueForApi} from '@salesforce/retail-react-app/app/components/express/utils/parsers'
import {AdyenShippingMethodsService} from '@salesforce/retail-react-app/app/components/express/utils/shipping-methods'
import {AdyenShippingAddressService} from '@salesforce/retail-react-app/app/components/express/utils/shipping-address'
import {AdyenPaymentsService} from '@salesforce/retail-react-app/app/components/express/utils/payments'
import {
    createTemporaryBasket,
    deleteTemporaryBasket,
    cleanupTemporaryBasket
} from '@salesforce/retail-react-app/app/components/express/utils/pdp/temporary-basket'
import {
    getBasketWithTotals,
    forceOrderCalculation
} from '@salesforce/retail-react-app/app/components/express/utils/pdp/basket-calculation'
import {useStandalonePaymentMethods} from '@salesforce/retail-react-app/app/components/express/hooks/use-standalone-payment-methods'
import useMultiSite from '@salesforce/retail-react-app/app/hooks/use-multi-site'
import useNavigation from '@salesforce/retail-react-app/app/hooks/use-navigation'
import {
    PAYMENT_METHODS,
    EXPRESS_MESSAGES
} from '@salesforce/retail-react-app/app/components/express/utils/constants'

const PAYMENT_METHOD = PAYMENT_METHODS.APPLE_PAY

const sendExpressMessage = (type, payload = {}) => {
    window.parent.postMessage(
        {
            type,
            payload
        },
        '*'
    )
}

export const getApplePaymentMethodConfig = (paymentMethodsResponse) => {
    const applePayPaymentMethod = paymentMethodsResponse?.paymentMethods?.find(
        (pm) => pm.type === PAYMENT_METHOD
    )
    return applePayPaymentMethod?.configuration || null
}

export const getCustomerShippingDetails = (shippingContact) => {
    return {
        deliveryAddress: {
            city: shippingContact.locality,
            country: shippingContact.countryCode,
            houseNumberOrName:
                shippingContact.addressLines?.length > 1 ? shippingContact.addressLines[1] : '',
            postalCode: shippingContact.postalCode,
            stateOrProvince: shippingContact.administrativeArea,
            street: shippingContact.addressLines?.[0]
        },
        profile: {
            firstName: shippingContact.givenName,
            lastName: shippingContact.familyName,
            email: shippingContact.emailAddress,
            phone: shippingContact.phoneNumber
        }
    }
}

export const getCustomerBillingDetails = (billingContact) => {
    return {
        billingAddress: {
            city: billingContact.locality,
            country: billingContact.countryCode,
            houseNumberOrName:
                billingContact?.addressLines?.length > 1 ? billingContact.addressLines[1] : '',
            postalCode: billingContact.postalCode,
            stateOrProvince: billingContact.administrativeArea,
            street: billingContact.addressLines?.[0]
        }
    }
}

export const getAppleButtonConfig = (
    finalAuthToken,
    site,
    basket,
    shippingMethods,
    applePayConfig,
    navigate,
    fetchShippingMethods,
    sku = null,
    setTempBasket = null,
    tempBasket = null,
    isPdpMode = false,
    quantity = 1
) => {
    // For PDP mode, prioritize temporary basket creation over existing basket
    // For regular mode, use existing basket
    const currentBasket = isPdpMode ? tempBasket : basket
    let applePayAmount = currentBasket?.orderTotal || 0

    // Shared basket reference to prevent multiple basket creation
    // This will be updated by callbacks and shared across all Apple Pay events
    // In PDP mode, start with null/tempBasket to force temporary basket creation
    let sharedBasketRef = isPdpMode ? tempBasket : currentBasket

    // Helper function to get or create basket (prevents multiple creation)
    const getOrCreateBasket = async () => {
        // If we already have a shared basket, return it
        if (sharedBasketRef && sharedBasketRef.basketId) {
            return sharedBasketRef
        }

        // For PDP flows, create temporary basket if needed (and SKU is available)
        if (isPdpMode && sku && setTempBasket) {
            const newBasket = await createTemporaryBasket(sku, finalAuthToken, site, quantity)
            sharedBasketRef = newBasket // Update shared reference immediately
            setTempBasket(newBasket) // Update React state for re-renders
            return newBasket
        }

        // Return null if no basket can be created/found
        return null
    }

    const buttonConfig = {
        showPayButton: true,
        isExpress: true,
        configuration: applePayConfig,
        amount: {
            value: getCurrencyValueForApi(
                currentBasket?.orderTotal || 0,
                currentBasket?.currency || 'USD'
            ),
            currency: currentBasket?.currency || 'USD'
        },
        requiredShippingContactFields: ['postalAddress', 'name', 'email', 'phone'],
        requiredBillingContactFields: ['postalAddress'],
        shippingMethods:
            shippingMethods?.map((sm) => ({
                label: sm.name,
                detail: sm.description,
                identifier: sm.id,
                amount: parseFloat(sm.price).toFixed(2)
            })) || [],
        onClick: async (resolve, reject) => {
            if (isPdpMode && setTempBasket) {
                // PDP "Buy Now" flow - get or create temporary basket
                try {
                    const basketToUse = await getOrCreateBasket()
                    if (!basketToUse) {
                        reject()
                        return
                    }

                    // Update the button config with the basket data
                    const totalToUse = basketToUse.orderTotal || basketToUse.productTotal || 0
                    buttonConfig.amount = {
                        value: getCurrencyValueForApi(totalToUse, basketToUse.currency),
                        currency: basketToUse.currency
                    }
                    applePayAmount = totalToUse

                    // Update the Apple Pay sheet with the current pricing
                    const priceUpdate = {
                        newTotal: {
                            type: 'final',
                            label: applePayConfig.merchantName || 'Total',
                            amount: parseFloat(applePayAmount).toFixed(2)
                        }
                    }
                    resolve(priceUpdate)
                } catch (error) {
                    await cleanupTemporaryBasket(
                        isPdpMode,
                        sharedBasketRef,
                        finalAuthToken,
                        site,
                        setTempBasket
                    )
                    reject()
                }
            } else {
                // Regular checkout flow
                resolve()
            }
        },
        onAuthorized: async (resolve, reject, event) => {
            try {
                const {shippingContact, billingContact, token} = event.payment

                const state = {
                    data: {
                        paymentType: 'express',
                        paymentMethod: {
                            type: 'applepay',
                            applePayToken: token.paymentData
                        },
                        ...getCustomerBillingDetails(billingContact),
                        ...getCustomerShippingDetails(shippingContact)
                    }
                }

                // Get or create basket using shared reference
                let currentBasket = await getOrCreateBasket()
                if (!currentBasket || !currentBasket.basketId) {
                    await cleanupTemporaryBasket(
                        isPdpMode,
                        sharedBasketRef,
                        finalAuthToken,
                        site,
                        setTempBasket
                    )
                    reject()
                    sendExpressMessage(EXPRESS_MESSAGES.PAYMENT_FAILURE, {
                        PAYMENT_METHOD
                    })
                    return
                }

                applePayAmount = currentBasket.orderTotal || currentBasket.productTotal || 0

                // CRITICAL: Force final order calculation before payment
                // This ensures orderTotal is calculated and not null
                try {
                    const finalizedBasket = await forceOrderCalculation(
                        currentBasket.basketId,
                        finalAuthToken,
                        site
                    )
                    currentBasket = finalizedBasket

                    // Update the amount tracking with calculated totals
                    applePayAmount = currentBasket.orderTotal || currentBasket.productTotal || 0

                    // Ensure we have a valid order total before proceeding
                    if (
                        currentBasket.orderTotal === null ||
                        currentBasket.orderTotal === undefined
                    ) {
                        await cleanupTemporaryBasket(
                            isPdpMode,
                            sharedBasketRef,
                            finalAuthToken,
                            site,
                            setTempBasket
                        )
                        reject()
                        sendExpressMessage(EXPRESS_MESSAGES.PAYMENT_FAILURE, {
                            PAYMENT_METHOD
                        })
                        return
                    }
                } catch (calculationError) {
                    // This is a critical error - we cannot proceed without order total
                    await cleanupTemporaryBasket(
                        isPdpMode,
                        sharedBasketRef,
                        finalAuthToken,
                        site,
                        setTempBasket
                    )
                    reject()
                    sendExpressMessage(EXPRESS_MESSAGES.PAYMENT_FAILURE, {
                        PAYMENT_METHOD
                    })
                    return
                }

                const paymentData = {
                    ...state.data,
                    origin: state.data.origin ? state.data.origin : window.location.origin
                }

                const adyenPaymentService = new AdyenPaymentsService(finalAuthToken, site)
                const paymentsResponse = await adyenPaymentService.submitPayment(
                    paymentData,
                    currentBasket?.basketId,
                    currentBasket?.customerInfo?.customerId
                )

                if (paymentsResponse?.isFinal && paymentsResponse?.isSuccessful) {
                    const finalPriceUpdate = {
                        newTotal: {
                            type: 'final',
                            label: applePayConfig.merchantName || 'Total',
                            amount: parseFloat(applePayAmount).toFixed(2)
                        }
                    }
                    resolve(finalPriceUpdate)

                    var orderId = paymentsResponse?.merchantReference

                    sendExpressMessage(EXPRESS_MESSAGES.PAYMENT_SUCCESS, {
                        orderId,
                        PAYMENT_METHOD
                    })
                } else {
                    // Clean up temporary basket on payment failure
                    await cleanupTemporaryBasket(
                        isPdpMode,
                        sharedBasketRef,
                        finalAuthToken,
                        site,
                        setTempBasket
                    )
                    reject()
                    sendExpressMessage(EXPRESS_MESSAGES.PAYMENT_FAILURE, {
                        PAYMENT_METHOD
                    })
                }
            } catch (err) {
                // Clean up temporary basket on any unexpected error
                await cleanupTemporaryBasket(
                    isPdpMode,
                    sharedBasketRef,
                    finalAuthToken,
                    site,
                    setTempBasket
                )
                reject()
                sendExpressMessage(EXPRESS_MESSAGES.PAYMENT_FAILURE, {
                    PAYMENT_METHOD
                })
            }
        },
        onSubmit: () => {},
        onShippingContactSelected: async (resolve, reject, event) => {
            try {
                const {shippingContact} = event

                // Get or create basket using shared reference
                let currentBasket = await getOrCreateBasket()
                if (!currentBasket || !currentBasket.basketId) {
                    reject()
                    return
                }

                const adyenShippingAddressService = new AdyenShippingAddressService(
                    finalAuthToken,
                    site
                )
                const adyenShippingMethodsService = new AdyenShippingMethodsService(
                    finalAuthToken,
                    site
                )
                const customerShippingDetails = getCustomerShippingDetails(shippingContact)
                await adyenShippingAddressService.updateShippingAddress(
                    currentBasket.basketId,
                    customerShippingDetails
                )

                // Get shipping methods - use fetchShippingMethods if available, otherwise use our service
                let newShippingMethods
                if (fetchShippingMethods && typeof fetchShippingMethods === 'function') {
                    newShippingMethods = await fetchShippingMethods(
                        currentBasket?.basketId,
                        site,
                        finalAuthToken
                    )
                } else {
                    // Fallback for "Buy Now" mode - use our shipping methods service
                    try {
                        const shippingMethodsResponse =
                            await adyenShippingMethodsService.getShippingMethods(
                                currentBasket.basketId
                            )

                        // Ensure the response has the expected format
                        if (
                            shippingMethodsResponse &&
                            shippingMethodsResponse.applicableShippingMethods
                        ) {
                            newShippingMethods = shippingMethodsResponse
                        } else if (Array.isArray(shippingMethodsResponse)) {
                            // Handle case where response is directly an array
                            newShippingMethods = {
                                applicableShippingMethods: shippingMethodsResponse
                            }
                        } else {
                            // No valid shipping methods available - fail the Apple Pay flow
                            newShippingMethods = null
                        }
                    } catch (error) {
                        // API call failed - fail the Apple Pay flow (no free shipping fallback)
                        newShippingMethods = null
                    }
                }

                if (!newShippingMethods?.applicableShippingMethods?.length) {
                    reject()
                } else {
                    const response = await adyenShippingMethodsService.updateShippingMethod(
                        newShippingMethods.applicableShippingMethods[0].id,
                        currentBasket.basketId
                    )

                    // Calculate basket totals after shipping method assignment
                    let finalResponse = response
                    try {
                        if (response.orderTotal === null || response.orderTotal === undefined) {
                            const calculatedBasket = await getBasketWithTotals(
                                currentBasket.basketId,
                                finalAuthToken,
                                site
                            )
                            finalResponse = calculatedBasket
                        }
                    } catch (calculationError) {
                        // Continue with original response if calculation fails
                    }

                    buttonConfig.amount = {
                        value: getCurrencyValueForApi(
                            finalResponse.orderTotal || finalResponse.productTotal || 0,
                            finalResponse.currency
                        ),
                        currency: finalResponse.currency
                    }
                    applePayAmount = finalResponse.orderTotal || finalResponse.productTotal || 0

                    // Ensure amount is formatted as string with proper decimal places
                    const formattedAmount = parseFloat(applePayAmount).toFixed(2)

                    const finalPriceUpdate = {
                        newShippingMethods: newShippingMethods?.applicableShippingMethods?.map(
                            (sm) => ({
                                label: sm.name,
                                detail: sm.description,
                                identifier: sm.id,
                                amount: parseFloat(sm.price).toFixed(2)
                            })
                        ),
                        newTotal: {
                            type: 'final',
                            label: applePayConfig.merchantName || 'Total',
                            amount: formattedAmount
                        }
                    }
                    resolve(finalPriceUpdate)
                }
            } catch (err) {
                reject()
            }
        },
        onShippingMethodSelected: async (resolve, reject, event) => {
            try {
                const {shippingMethod} = event

                // Get or create basket using shared reference
                let currentBasket = await getOrCreateBasket()
                if (!currentBasket || !currentBasket.basketId) {
                    reject()
                    return
                }

                const adyenShippingMethodsService = new AdyenShippingMethodsService(
                    finalAuthToken,
                    site
                )
                const response = await adyenShippingMethodsService.updateShippingMethod(
                    shippingMethod.identifier,
                    currentBasket.basketId
                )
                if (response.error) {
                    reject()
                } else {
                    // Calculate basket totals after shipping method update
                    let finalResponse = response
                    try {
                        if (response.orderTotal === null || response.orderTotal === undefined) {
                            const calculatedBasket = await getBasketWithTotals(
                                currentBasket.basketId,
                                finalAuthToken,
                                site
                            )
                            finalResponse = calculatedBasket
                        }
                    } catch (calculationError) {
                        // Continue with original response if calculation fails
                    }

                    buttonConfig.amount = {
                        value: getCurrencyValueForApi(
                            finalResponse.orderTotal || finalResponse.productTotal || 0,
                            finalResponse.currency
                        ),
                        currency: finalResponse.currency
                    }
                    applePayAmount = finalResponse.orderTotal || finalResponse.productTotal || 0

                    // Ensure amount is formatted as string with proper decimal places
                    const formattedAmount = parseFloat(applePayAmount).toFixed(2)

                    const applePayShippingMethodUpdate = {
                        newTotal: {
                            type: 'final',
                            label: applePayConfig.merchantName || 'Total',
                            amount: formattedAmount
                        }
                    }
                    resolve(applePayShippingMethodUpdate)
                }
            } catch (err) {
                reject()
            }
        },
        onError: (error) => {
            // Clean up temporary basket when Apple Pay is cancelled or fails
            if (error.name === 'CANCEL') {
                cleanupTemporaryBasket(
                    isPdpMode,
                    sharedBasketRef,
                    finalAuthToken,
                    site,
                    setTempBasket
                )
                sendExpressMessage(EXPRESS_MESSAGES.PAYMENT_CANCEL, {
                    PAYMENT_METHOD
                })
            } else {
                cleanupTemporaryBasket(
                    isPdpMode,
                    sharedBasketRef,
                    finalAuthToken,
                    site,
                    setTempBasket
                )
                sendExpressMessage(EXPRESS_MESSAGES.PAYMENT_FAILURE, {
                    PAYMENT_METHOD
                })
            }
        }
    }
    return buttonConfig
}

export const ApplePayExpress = ({
    sku,
    quantity = 1,
    isPdpMode = false,
    basketData,
    authToken: providedAuthToken,
    manager,
    overrideData = null
}) => {
    const {locale, site} = useMultiSite()
    const navigate = useNavigation()

    const [tempBasket, setTempBasket] = useState(null)
    const [currentSku, setCurrentSku] = useState(sku)

    const paymentContainer = useRef(null)

    // In PDP mode, we simply ignore the data since we don't have a provider
    const regularAdyenData = useAdyenExpressCheckout()

    // Use override data if available, otherwise fall back to provided or provider data
    const finalAuthToken =
        overrideData?.authToken ||
        (isPdpMode ? providedAuthToken : regularAdyenData?.authToken || providedAuthToken)
    const finalBasketData = overrideData?.basket || basketData

    // Check if we have the minimum required basket data (from basket only)
    // Note: This is now handled in the preloadCriticalData function

    // For PDP mode, use standalone payment methods
    // For regular mode, use the standard Adyen hook data
    const {
        paymentMethods: standalonePaymentMethods,
        loading: standaloneLoading,
        error: standaloneError
    } = useStandalonePaymentMethods(finalAuthToken, site, locale, isPdpMode && !!finalAuthToken)

    // Preload critical data in parallel for better performance
    const preloadCriticalData = useCallback(async () => {
        if (isPdpMode) {
            // For PDP mode, we only need payment methods
            return {
                environment: standalonePaymentMethods?.environment,
                paymentMethods: standalonePaymentMethods,
                basketData: null
            }
        } else {
            // For regular mode, we need both environment and basket data
            return {
                environment: regularAdyenData.adyenEnvironment,
                paymentMethods: regularAdyenData.adyenPaymentMethods,
                basketData: finalBasketData
            }
        }
    }, [isPdpMode, standalonePaymentMethods, regularAdyenData, finalBasketData])

    // Handle SKU prop changes (for postMessage updates)
    useEffect(() => {
        if (sku !== currentSku) {
            // Clean up previous temporary basket if switching SKUs
            if (currentSku && tempBasket?.basketId && finalAuthToken && site) {
                deleteTemporaryBasket(tempBasket.basketId, finalAuthToken, site).catch((error) =>
                    console.warn('Failed to cleanup previous temporary basket:', error)
                )
                setTempBasket(null)
            }
            setCurrentSku(sku)
        }
    }, [sku, currentSku, tempBasket?.basketId, finalAuthToken, site])

    // Preload critical data early for better performance
    useEffect(() => {
        // Start preloading data as soon as we have the minimum required dependencies
        if (finalAuthToken && site) {
            // Trigger preload in background
            preloadCriticalData().catch(() => {
                // Silently fail preload, will retry in createCheckout
            })
        }
    }, [finalAuthToken, site, preloadCriticalData])

    // Handle errors in standalone payment methods for PDP mode
    useEffect(() => {
        if (isPdpMode && standaloneError && !standaloneLoading) {
            // If we have an error in standalone payment methods, mark Apple Pay as unavailable
            manager.setPaymentMethodUnavailable(PAYMENT_METHOD)
        }
    }, [isPdpMode, standaloneError, standaloneLoading, manager])

    const adyenEnvironment = isPdpMode
        ? standalonePaymentMethods?.environment
        : regularAdyenData.adyenEnvironment

    const adyenPaymentMethods = isPdpMode
        ? standalonePaymentMethods
        : regularAdyenData.adyenPaymentMethods
    const shippingMethods = isPdpMode ? null : regularAdyenData.shippingMethods
    const fetchShippingMethods = isPdpMode ? null : regularAdyenData.fetchShippingMethods

    // Cleanup effect to remove temporary basket when component unmounts
    useEffect(() => {
        return () => {
            // Clean up temporary basket when component unmounts (user navigates away)
            if (isPdpMode && currentSku && tempBasket?.basketId && finalAuthToken && site) {
                deleteTemporaryBasket(tempBasket.basketId, finalAuthToken, site).catch((error) =>
                    console.warn('Failed to cleanup temporary basket on unmount:', error)
                )
            }
        }
    }, [tempBasket?.basketId, finalAuthToken, site?.id, currentSku, isPdpMode])

    useEffect(() => {
        let isCanceled = false

        const createCheckout = async () => {
            if (isCanceled) {
                return
            }

            const handleApplePayUnavailable = () => {
                manager.setPaymentMethodUnavailable(PAYMENT_METHOD)
            }

            // Use preloaded data for better performance
            const requiredData = await preloadCriticalData()

            // Check if we have the minimum required data
            if (!requiredData?.environment || !requiredData?.paymentMethods) {
                // Data not ready yet, schedule retry on next tick
                setTimeout(() => createCheckout(), 0)
                return
            }

            // For regular mode, also check basket data
            if (!isPdpMode && !requiredData.basketData) {
                // Basket data not ready yet, schedule retry on next tick
                setTimeout(() => createCheckout(), 0)
                return
            }

            const {environment, paymentMethods, basketData} = requiredData

            try {
                let checkout
                try {
                    checkout = await AdyenCheckout({
                        environment: environment.ADYEN_ENVIRONMENT,
                        clientKey: environment.ADYEN_CLIENT_KEY,
                        locale: locale.id,
                        analytics: {
                            analyticsData: {
                                applicationInfo: paymentMethods?.applicationInfo
                            }
                        }
                    })
                } catch (ex) {
                    console.error('Failed to initialize AdyenCheckout:', ex)
                    handleApplePayUnavailable()
                    return
                }

                const applePaymentMethodConfig = getApplePaymentMethodConfig(paymentMethods)

                if (!applePaymentMethodConfig) {
                    console.warn('Apple Pay configuration not found in payment methods')
                    handleApplePayUnavailable()
                    return
                }

                const appleButtonConfig = getAppleButtonConfig(
                    finalAuthToken,
                    site,
                    basketData || finalBasketData,
                    shippingMethods?.applicableShippingMethods || [],
                    applePaymentMethodConfig,
                    navigate,
                    fetchShippingMethods,
                    currentSku,
                    setTempBasket,
                    tempBasket,
                    isPdpMode,
                    quantity
                )

                let applePayButton
                try {
                    applePayButton = await checkout.create('applepay', appleButtonConfig)
                } catch (ex) {
                    console.error('Failed to create Apple Pay button:', ex)
                    handleApplePayUnavailable()
                    return
                }

                let isApplePayButtonAvailable = false
                try {
                    isApplePayButtonAvailable = await applePayButton.isAvailable()
                } catch (ex) {
                    isApplePayButtonAvailable = false
                }

                if (!isApplePayButtonAvailable) {
                    handleApplePayUnavailable()
                    return
                }

                try {
                    await applePayButton.mount(paymentContainer.current)
                    manager.setPaymentMethodAvailable(PAYMENT_METHOD)
                } catch (error) {
                    console.error('Failed to mount Apple Pay button:', error)
                    handleApplePayUnavailable()
                }
            } catch (err) {
                console.error('Full error details:', err)
                const isMissingOrderTotalError =
                    err instanceof TypeError &&
                    err.message == "undefined is not an object (evaluating 'a.orderTotal')"

                // For PDP mode, missing order total is expected initially when no SKU is set
                const isExpectedPdpError = isPdpMode && isMissingOrderTotalError && !tempBasket

                if (!isMissingOrderTotalError && !isExpectedPdpError) {
                    handleApplePayUnavailable()
                }
            }
        }

        createCheckout()

        return () => {
            isCanceled = true
        }
    }, [
        adyenEnvironment,
        adyenPaymentMethods,
        isPdpMode,
        quantity,
        ...(isPdpMode
            ? [
                  tempBasket,
                  currentSku,
                  shippingMethods,
                  standalonePaymentMethods,
                  standaloneLoading,
                  standaloneError
              ]
            : [])
    ])

    return <div ref={paymentContainer}></div>
}

ApplePayExpress.propTypes = {
    shippingMethods: PropTypes.array,
    sku: PropTypes.string,
    quantity: PropTypes.number,
    isPdpMode: PropTypes.bool,
    basketData: PropTypes.object,
    authToken: PropTypes.string,
    manager: PropTypes.object,
    overrideData: PropTypes.object
}
