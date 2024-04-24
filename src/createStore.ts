import equal from 'fast-deep-equal'
import { useEffect, useMemo, useReducer, useState, useSyncExternalStore } from 'react'
import { Actions, Dispatch, InitialState } from './types'
import { getActionKey, isPromise, isSynchronizer, optionalArray } from './utils'

const keyInObject = <T extends object>(key: PropertyKey, obj: T): key is keyof T => key in obj

export const createStore = <TState extends object>(stateRaw: InitialState<TState>) => {
    const storeKeys = Object.keys(stateRaw) as Array<keyof TState>

    const actions = storeKeys.reduce((acc, key) => ({
        ...acc,
        [getActionKey(key)]: (value: Dispatch<TState, typeof key>) => {
            if (typeof value === 'function') {
                const fn = value as (prevState: TState[typeof key]) => TState[typeof key]
                const newValue = fn(state[key])

                state[key] = newValue
                listeners[key].forEach(listener => listener(newValue))

                return
            }

            state[key] = value
            listeners[key].forEach(listener => listener(value))
        },
    }), {} as Actions<TState>)

    // @ts-expect-error
    const getAction = <K extends keyof TState>(key: K) => actions[getActionKey(key)] as (value: unknown) => void

    const listeners = storeKeys.reduce((acc, key) => ({
        ...acc,
        [key]: [],
    }), {} as { [K in keyof TState]: Array<(newState: TState[K]) => void> })

    const state = Object.entries(stateRaw).reduce((acc, [key, value]) => {
        if (typeof value === 'function') {
            throw new Error('Function cannot be passed as top level state value')
        }

        if (isSynchronizer(value)) {
            value.subscribe?.(getAction(key as keyof TState), key)
            listeners[key as keyof TState].push(newValue => value.update(newValue, key))

            try {
                const snapshotValue = value.getSnapshot(key)

                if (isPromise(snapshotValue)) {
                    snapshotValue.then(snapshotValue => {
                        if (snapshotValue !== undefined && snapshotValue !== null) {
                            getAction(key as keyof TState)(snapshotValue)

                            return
                        }

                        value.update(value.value, key)
                    }).catch()

                    // Return initial value
                    return {
                        ...acc,
                        [key]: value.value,
                    }
                }

                return {
                    ...acc,
                    [key]: snapshotValue,
                }
            } catch {
                // If getSnapshot throws, return initial value and set it in storage
                value.update(value.value, key)

                return {
                    ...acc,
                    [key]: value.value,
                }
            }
        }

        return {
            ...acc,
            [key]: value,
        }
    }, {}) as { [K in keyof TState]: TState[K] }

    const subscribe = <TKeys extends Array<keyof TState>>(keys: TKeys) => (listener: VoidFunction) => {
        keys.forEach(key => listeners[key].push(listener))

        return () => {
            keys.forEach(key => {
                listeners[key] = listeners[key].filter(l => l !== listener)
            })
        }
    }

    const getState = <TKeys extends keyof TState>(keys: Array<TKeys>) => {
        type State = { [K in TKeys]: TState[K] } & {}
        let oldState: State

        return () => {
            const newState = keys.reduce((acc, key) => ({
                ...acc,
                [key]: state[key],
            }), {}) as State

            if (equal(oldState, newState)) {
                return oldState
            }

            oldState = newState

            return newState
        }
    }

    const useStore = () => {
        const [_, recalculate] = useReducer(() => ({}), {})
        const [subscribeKeys] = useState(() => new Set<keyof TState>())
        const getSnapshot = useMemo(() => {
            if (subscribeKeys.size === 0) {
                return () => state
            }

            return getState(Array.from(subscribeKeys))
        }, [_])
        const subscribeStore = useMemo(() => {
            if (subscribeKeys.size === 0) {
                return () => () => {}
            }

            return subscribe(Array.from(subscribeKeys))
        }, [_])
        const synced = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot)

        return new Proxy({ ...synced, ...actions }, {
            get: (target, key) => {
                if (storeKeys.includes(key as keyof TState) && !subscribeKeys.has(key as keyof TState)) {
                    subscribeKeys.add(key as keyof TState)
                    recalculate()
                }

                if (keyInObject(key, target)) {
                    return target[key]
                }

                return undefined
            },
        })
    }

    const reset = <TKeys extends Array<keyof TState>>(...keys: [...TKeys]) => {
        optionalArray(keys, storeKeys).forEach(key => {
            const valueOrSynchronizer = stateRaw[key]
            const initialValue = isSynchronizer(valueOrSynchronizer) ? valueOrSynchronizer.value : valueOrSynchronizer

            getAction(key)(initialValue)
        })
    }

    const effect = <TKeys extends Array<keyof TState>>(run: (state: TState) => void, deps: [...TKeys]) => {
        run(getState(storeKeys)())

        return subscribe(deps)(() => {
            run(getState(storeKeys)())
        })
    }

    const useStoreEffect = <TKeys extends Array<keyof TState>>(run: (state: TState) => void, deps: [...TKeys]) => {
        useEffect(() => {
            const dispose = effect(run, deps)

            return dispose
        }, [])
    }

    return {
        useStore,
        getState: () => state,
        actions,
        reset,
        effect,
        useStoreEffect,
    }
}
