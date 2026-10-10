Allows you to wrap many kinds of operations, see [`INVOKE`](https://example.invalid/javadoc/BeforeInvoke.html) and [`FIELD`](https://example.invalid/javadoc/BeforeFieldAccess.html).

Should be used in favour of `Redirect`s because it chains when used by multiple mods.

### Example

```java
@WrapOperation(method = "targetMethod", at = @At(value = "INVOKE", target = "Lsome/Class;expensiveCalculation(Z)I"))
private int bypass(SomeClass instance, boolean flag, Operation<Integer> original) {
    return original.call(instance, flag);
}
```
