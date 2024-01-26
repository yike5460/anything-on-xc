#!/bin/bash

INSTANCE_TYPE="g5.2xlarge"

# Initial AMI
# aws ec2 describe-images \
#     --owners amazon \
#     --filters "Name=name,Values=Deep Learning Base OSS Nvidia Driver GPU AMI*" "Name=is-public,Values=true" "Name=state,Values=available" \
#     --query "Images[*].[ImageId,Name,Description]" \
#     --region us-east-1 \
#     --output json | jq -r 'sort_by(.[1] | capture(".* (?<date>[0-9]+)$").date | strptime("%Y%m%d") | mktime) | .[-1][0]'

# Packed AMI
# aws ec2 create-image --instance-id <instance id running on initial AMI> --name "stableDiffusionOnEc2V1" --description "AMI packed Stable Diffusion WebUI dependencies and system service launched based on Deep Learning Base OSS Nvidia Driver GPU AMI" --region us-east-1

AMI_ID="ami-0da2ab58cace8997d"

# aws ec2 describe-key-pairs --region us-east-1 --query 'KeyPairs[*].KeyName' --output text
KEY_NAME="<your-key-pair-name>" # Replace with your key pair name

# vpc_id=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --region us-east-1 --query 'Vpcs[*].VpcId' --output text)
# aws ec2 describe-security-groups --filters Name=vpc-id,Values=vpc-your-vpc-id Name=group-name,Values=default --region us-east-1 --query 'SecurityGroups[*].GroupId' --output text
SECURITY_GROUP=<your-sg-id>
# aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-your-vpc-id --region us-east-1 --query 'Subnets[*].SubnetId' --output text
SUBNET_ID=<your-subnet-id>
ITERATIONS=5
LAUNCH_TIMES=()

# Function to get the duration between start and end time
get_duration() {
    local start=\$1
    local end=\$2
    echo "$(( end - start ))"
}

# Function to launch and terminate instance
launch_instance() {
    # Launch the instance
    local instance_info=$(aws ec2 run-instances --image-id $AMI_ID --count 1 --instance-type $INSTANCE_TYPE --key-name $KEY_NAME --security-group-ids $SECURITY_GROUP --subnet-id $SUBNET_ID --region us-east-1)
    local instance_id=$(echo $instance_info | jq -r .Instances[0].InstanceId)
    echo "Launched instance $instance_id" >&2

    # Wait for the instance to become available
    # aws ec2 wait instance-running --instance-ids $instance_id --region us-east-1, avg 17-18s/per instance

    # Poll to wait for the instance to become available, option 1, avg 9s/per instance
    # while true; do
    #     local instance_state=$(aws ec2 describe-instances --instance-ids $instance_id --region us-east-1 | jq -r .Reservations[0].Instances[0].State.Name)
    #     if [[ $instance_state == "running" ]]; then
    #         break
    #     fi
    #     sleep 1
    # done

    # Poll to wait for the instance to become available, option 2, avg 159s/per instance
    while true; do
        local instance_state=$(aws ec2 describe-instance-status --instance-ids $instance_id --region us-east-1 | jq -r .InstanceStatuses[0].InstanceStatus.Status)
        if [[ $instance_state == "ok" ]]; then
            break
        fi
        sleep 1
    done

    # TODO, application specific health check, wait for the application to be ready
    # Curl the application using the public ip address and port 7860
    # while true; do
    #     local response_code=$(curl -s -o /dev/null -w "%{http_code}" http://$(aws ec2 describe-instances --instance-ids $instance_id --region us-east-1 | jq -r .Reservations[0].Instances[0].PublicIpAddress):7860)
    #     if [[ $response_code == "200" ]]; then
    #         break
    #     fi
    #     sleep 1
    # done

    # Check the system log (optional validation)
    # aws ec2 get-console-output --instance-id $instance_id | grep "some validation text"

    # return the instance id
    echo $instance_id
}

# Main loop for benchmarking
for (( i=0; i<$ITERATIONS; i++ )); do
    start_time=$(date +%s)
    instance_id=$(launch_instance)
    end_time=$(date +%s)
    echo "Debug: Start time for iteration $((i+1)) is $start_time" >&2
    echo "Debug: End time for iteration $((i+1)) is $end_time" >&2
    # duration=$(get_duration $start_time $end_time)
    duration=$(( end_time - start_time ))
    LAUNCH_TIMES+=($duration)
    echo "Launch time for iteration $((i+1)): ${LAUNCH_TIMES[$i]} seconds"

    # Terminate the instance
    echo "Terminated instance $instance_id"
    aws ec2 terminate-instances --instance-ids $instance_id --region us-east-1
    echo "Now waiting for instance $instance_id to terminate"
    aws ec2 wait instance-terminated --instance-ids $instance_id --region us-east-1
done

# Calculate average launch time
total_time=0
for time in "${LAUNCH_TIMES[@]}"; do
    total_time=$((total_time + time))
done
average_time=$(echo "scale=2; $total_time / $ITERATIONS" | bc)

echo "Average launch time: $average_time seconds"