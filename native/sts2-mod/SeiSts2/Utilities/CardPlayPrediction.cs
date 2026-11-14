using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Models;

namespace Sts2Agent.Utilities;

public static class CardPlayPrediction
{
    private const BindingFlags NonPublicInstance = BindingFlags.NonPublic | BindingFlags.Instance;
    private const int OpcodeTableSize = 256;
    private const byte MultiByteOpcodePrefix = 0xFE;

    private static readonly ConcurrentDictionary<Type, Prediction> Cache = new();
    private static readonly OpCode[] SingleByteOpCodes = BuildOpcodeLookup(multiByte: false);
    private static readonly OpCode[] MultiByteOpCodes = BuildOpcodeLookup(multiByte: true);

    public enum ContextChange
    {
        None,
        HandSelection,
        CardSelection
    }

    public readonly record struct Prediction(ContextChange Context)
    {
        public bool MayChangeContext => Context != ContextChange.None;
    }

    public static Prediction Predict(CardModel card)
    {
        ArgumentNullException.ThrowIfNull(card);
        return Cache.GetOrAdd(card.GetType(), PredictForType);
    }

    private static Prediction PredictForType(Type cardType)
    {
        try
        {
            MethodInfo? onPlay = cardType.GetMethod(
                "OnPlay",
                NonPublicInstance,
                binder: null,
                types: [typeof(PlayerChoiceContext), typeof(CardPlay)],
                modifiers: null);

            if (onPlay == null)
                return default;

            MethodInfo inspectedMethod = onPlay;
            Type? stateMachineType = onPlay.GetCustomAttribute<AsyncStateMachineAttribute>()?.StateMachineType;
            MethodInfo? moveNext = stateMachineType?.GetMethod(
                "MoveNext",
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            if (moveNext != null)
                inspectedMethod = moveNext;

            foreach (MethodBase calledMethod in GetCalledMethods(inspectedMethod))
            {
                if (calledMethod.DeclaringType != typeof(CardSelectCmd))
                    continue;

                switch (calledMethod.Name)
                {
                    case nameof(CardSelectCmd.FromHand):
                    case nameof(CardSelectCmd.FromHandForDiscard):
                        return new Prediction(ContextChange.HandSelection);
                    case nameof(CardSelectCmd.FromSimpleGrid):
                    case nameof(CardSelectCmd.FromChooseACardScreen):
                        return new Prediction(ContextChange.CardSelection);
                }
            }
        }
        catch (Exception e)
        {
            global::Sts2Agent.Plugin.LogDebug(
                $"CardPlayPrediction: failed to inspect {cardType.FullName}: {e.Message}");
        }

        return default;
    }

    private static IEnumerable<MethodBase> GetCalledMethods(MethodInfo method)
    {
        MethodBody? body = method.GetMethodBody();
        byte[]? il = body?.GetILAsByteArray();
        if (il == null)
            yield break;

        Type[]? typeArguments = method.DeclaringType?.GetGenericArguments();
        Type[] methodArguments = method.GetGenericArguments();

        for (int index = 0; index < il.Length;)
        {
            OpCode opCode = ReadOpcode(il, ref index);
            if (opCode.OperandType == OperandType.InlineMethod)
            {
                if (index + sizeof(int) > il.Length)
                    yield break;

                MethodBase? calledMethod = null;
                int metadataToken = BitConverter.ToInt32(il, index);
                index += sizeof(int);

                try
                {
                    calledMethod = method.Module.ResolveMethod(metadataToken, typeArguments, methodArguments);
                }
                catch (ArgumentException)
                {
                }

                if (calledMethod != null)
                    yield return calledMethod;

                continue;
            }

            index += GetOperandSize(opCode.OperandType, il, index);
        }
    }

    private static OpCode ReadOpcode(byte[] il, ref int index)
    {
        byte leadingByte = il[index++];
        if (leadingByte == MultiByteOpcodePrefix && index < il.Length)
            return MultiByteOpCodes[il[index++]];
        return SingleByteOpCodes[leadingByte];
    }

    private static int GetOperandSize(OperandType operandType, byte[] il, int operandIndex)
    {
        return operandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget => 1,
            OperandType.ShortInlineI => 1,
            OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineI => 4,
            OperandType.InlineBrTarget => 4,
            OperandType.InlineField => 4,
            OperandType.InlineMethod => 4,
            OperandType.InlineSig => 4,
            OperandType.InlineString => 4,
            OperandType.InlineTok => 4,
            OperandType.InlineType => 4,
            OperandType.ShortInlineR => 4,
            OperandType.InlineI8 => 8,
            OperandType.InlineR => 8,
            OperandType.InlineSwitch when operandIndex + sizeof(int) <= il.Length
                => sizeof(int) + (BitConverter.ToInt32(il, operandIndex) * sizeof(int)),
            _ => 0
        };
    }

    private static OpCode[] BuildOpcodeLookup(bool multiByte)
    {
        OpCode[] lookup = new OpCode[OpcodeTableSize];
        foreach (FieldInfo field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            if (field.GetValue(null) is not OpCode opCode || (opCode.Size == 2) != multiByte)
                continue;

            int index = multiByte ? opCode.Value & byte.MaxValue : (byte)opCode.Value;
            lookup[index] = opCode;
        }
        return lookup;
    }
}
